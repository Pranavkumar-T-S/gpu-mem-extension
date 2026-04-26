// =============================================================================
// gpu_memory.js — Universal WebGL/WebGL2 GPU memory profiler
//
// Inject this BEFORE the target app's scripts run (e.g., Chrome DevTools
// "Override page", a content script with run_at: "document_start", or
// CDP Page.addScriptToEvaluateOnNewDocument).
//
// On load:
//   - Patches HTMLCanvasElement.prototype.getContext + OffscreenCanvas.getContext
//   - For every webgl/webgl2 context returned, installs per-instance hooks on
//     allocation / lifecycle / binding / framebuffer-attachment methods
//   - Maintains complete bookkeeping (textures, buffers, RBs, FBOs) per context
//
// Public API:
//   window.gpuMemReport(opts?) -> aggregate report across all hooked contexts
//     opts: { verbose?: bool, perContext?: bool, canvas?: HTMLCanvasElement }
//
//   window.installGpuMemHooks(gl) -> manually hook a context that pre-existed
//                                    or escaped our getContext patch
//
// No Emscripten dependency. No required arguments at report time.
// =============================================================================

(function () {
  if (typeof self === 'undefined') return;
  const G = self;
  if (G.__GPU_MEM__) return;  // idempotent
  const REG = G.__GPU_MEM__ = { contexts: new Set(), version: '0.1' };

  // ------------------------------------------------------------------
  // Reference-holding policy.
  //   holdRefs = true  (default): we strongly reference every tracked
  //     WebGL object so the profiler doubles as a leak detector — even
  //     if the app drops its own refs, the entry persists and shows up
  //     in reports.
  //   holdRefs = false: we release our strong refs and let the browser
  //     auto-delete via the WebGL spec's GC clause. Use this to find
  //     real GPU bugs in app code without our profiler keeping things
  //     alive. A FinalizationRegistry removes the entry when the JS
  //     wrapper is collected (timing is non-deterministic, see notes).
  // Toggle via window.gpuMemSetHoldRefs(bool).
  // ------------------------------------------------------------------
  let holdRefs = true;
  const finReg = (typeof FinalizationRegistry !== 'undefined')
    ? new FinalizationRegistry(({ map, id }) => { try { map.delete(id); } catch (_) { } })
    : null;

  // ------------------------------------------------------------------
  // Call-stack capture (off by default — has measurable overhead since
  // every tracked GL call would build an Error to read .stack).
  // Toggle via window.gpuMemSetCaptureStacks(bool).
  // ------------------------------------------------------------------
  let captureStacks = false;
  // V8 truncates Error.stack to 10 frames by default; lift it so captured
  // stacks reach deeper allocation sites. Per-realm global; ignored by
  // Firefox/Safari (they have their own, usually larger, limits).
  try { Error.stackTraceLimit = 200; } catch (_) { }
  // Pattern that identifies frames inside this profiler. Any leading
  // frame matching this is stripped so the first line of the returned
  // stack is real app code. Matches the file name and our public API
  // names so it survives bundlers / different injection paths.
  const SELF_FRAME_RE = /gpu_memory|gpuMem|grabStack/;
  // Frames matching this pattern (and everything below them) are dropped
  // from the captured stack. These are runtime / event-loop frames that
  // recur every animation frame and add noise without information about
  // *which* allocation site we care about.
  const STOP_FRAME_RE = /requestAnimationFrame|onAnimationFrame|MessagePort|postTask|runMicrotasks|Promise\.then|setTimeout|setInterval|dispatchEvent|EventListener/;
  function grabStack() {
    if (!captureStacks) return undefined;
    const s = new Error().stack;
    if (!s) return undefined;
    const lines = s.split('\n');
    let i = 0;
    // V8/JSC prepend an "Error" header line; Firefox does not.
    if (/^Error/.test(lines[0])) i = 1;
    // Drop every leading frame that points inside this file.
    while (i < lines.length && SELF_FRAME_RE.test(lines[i])) i++;
    // Walk forward; cut the stack at the first runtime/event-loop frame.
    let end = i;
    while (end < lines.length && !STOP_FRAME_RE.test(lines[end])) end++;
    return lines.slice(i, end).join('\n') || undefined;
  }

  // ------------------------------------------------------------------
  // Format -> bytes-per-pixel table. Built from a probe context the
  // first time we hook one (so we can resolve enum values).
  // ------------------------------------------------------------------
  let FMT = null;
  function buildFmtTable(gl) {
    const t = {};
    const F = (name, bpp) => { if (gl[name] !== undefined) t[gl[name]] = { name, bpp }; };
    F('R8', 1); F('RG8', 2); F('RGB8', 3); F('RGBA8', 4); F('SRGB8', 3); F('SRGB8_ALPHA8', 4);
    F('R8_SNORM', 1); F('RG8_SNORM', 2); F('RGB8_SNORM', 3); F('RGBA8_SNORM', 4);
    F('R16F', 2); F('RG16F', 4); F('RGB16F', 6); F('RGBA16F', 8);
    F('R16I', 2); F('RG16I', 4); F('RGB16I', 6); F('RGBA16I', 8);
    F('R16UI', 2); F('RG16UI', 4); F('RGB16UI', 6); F('RGBA16UI', 8);
    F('R32F', 4); F('RG32F', 8); F('RGB32F', 12); F('RGBA32F', 16);
    F('R32I', 4); F('RG32I', 8); F('RGB32I', 12); F('RGBA32I', 16);
    F('R32UI', 4); F('RG32UI', 8); F('RGB32UI', 12); F('RGBA32UI', 16);
    F('RGB565', 2); F('RGBA4', 2); F('RGB5_A1', 2); F('RGB10_A2', 4); F('RGB10_A2UI', 4);
    F('R11F_G11F_B10F', 4); F('RGB9_E5', 4);
    F('R8I', 1); F('RG8I', 2); F('RGB8I', 3); F('RGBA8I', 4);
    F('R8UI', 1); F('RG8UI', 2); F('RGB8UI', 3); F('RGBA8UI', 4);
    F('DEPTH_COMPONENT16', 2); F('DEPTH_COMPONENT24', 4); F('DEPTH_COMPONENT32F', 4);
    F('DEPTH24_STENCIL8', 4); F('DEPTH32F_STENCIL8', 5); F('STENCIL_INDEX8', 1);
    F('LUMINANCE', 1); F('ALPHA', 1); F('LUMINANCE_ALPHA', 2); F('RGB', 3); F('RGBA', 4);
    return t;
  }
  const bppFor = (fmt) => (FMT && FMT[fmt]?.bpp) ?? 4;
  const fmtName = (fmt) => (FMT && FMT[fmt]?.name) ?? ('0x' + (fmt | 0).toString(16));
  function mipBytes(base, levels) {
    if (!levels || levels <= 1) return base;
    let total = 0, b = base;
    for (let i = 0; i < levels; i++) { total += b; b = Math.max(1, Math.floor(b / 4)); }
    return total;
  }
  // generateMipmap auto-expansion factor for a full chain
  const MIP_CHAIN_FACTOR = 4 / 3;

  // ------------------------------------------------------------------
  // Per-context bookkeeping initialiser
  // ------------------------------------------------------------------
  function ensureMem(gl) {
    if (gl.__mem) return gl.__mem;
    gl.__mem = {
      // Tracking maps are keyed by an internal numeric id so that the
      // Map itself does NOT hold a strong ref to the WebGL object.
      // Strong refs (when enabled) live in the *Hold Sets below.
      textures: new Map(),  // id -> entry
      buffers: new Map(),  // id -> entry
      renderbuffers: new Map(),  // id -> entry
      framebuffers: new Map(),  // id -> { attachments: {} }
      texById: new WeakMap(), bufById: new WeakMap(),
      rbById: new WeakMap(), fbById: new WeakMap(),
      texHold: new Set(), bufHold: new Set(),
      rbHold: new Set(), fbHold: new Set(),
      nextId: 0,
      bindings: {
        TEXTURE_2D: null, TEXTURE_CUBE_MAP: null,
        TEXTURE_2D_ARRAY: null, TEXTURE_3D: null,
        ARRAY_BUFFER: null, ELEMENT_ARRAY_BUFFER: null,
        UNIFORM_BUFFER: null, PIXEL_PACK_BUFFER: null,
        PIXEL_UNPACK_BUFFER: null, COPY_READ_BUFFER: null,
        COPY_WRITE_BUFFER: null, TRANSFORM_FEEDBACK_BUFFER: null,
        FRAMEBUFFER: null, READ_FRAMEBUFFER: null, DRAW_FRAMEBUFFER: null,
        RENDERBUFFER: null
      },
      label: gl.canvas?.id || gl.canvas?.tagName || 'canvas',
      isWebGL2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
    };
    return gl.__mem;
  }

  // ------------------------------------------------------------------
  // Hook installer (instance-only patching via own-property shadowing)
  // ------------------------------------------------------------------
  function installHooks(gl) {
    if (!gl || gl.__memHooked) return gl;
    gl.__memHooked = true;
    if (!FMT) FMT = buildFmtTable(gl);
    const mem = ensureMem(gl);
    REG.contexts.add(gl);

    // Context loss: driver frees all GL resources, our Maps must be cleared
    // to avoid over-reporting. The browser fires `webglcontextlost` on the
    // canvas. After `webglcontextrestored` the app recreates everything,
    // and our hooks will repopulate the Maps from scratch.
    if (gl.canvas && typeof gl.canvas.addEventListener === 'function') {
      gl.canvas.addEventListener('webglcontextlost', () => {
        mem.textures.clear();
        mem.buffers.clear();
        mem.renderbuffers.clear();
        mem.framebuffers.clear();
        mem.texHold.clear(); mem.bufHold.clear();
        mem.rbHold.clear(); mem.fbHold.clear();
        // WeakMaps auto-clear when their key objects are GC'd.
        for (const k of Object.keys(mem.bindings)) mem.bindings[k] = null;
      });
    }

    // Helper: wrap a method so our `after` hook runs after the real GL call
    // returns (with both the original args and the return value), then return
    // the original result to the caller. If the real call throws, we rethrow
    // and skip the hook (so we never record state the driver rejected).
    function wrap(name, after) {
      const orig = gl[name];
      if (typeof orig !== 'function') return;
      const bound = orig.bind(gl);
      gl[name] = function (...args) {
        const result = bound(...args);
        try { after(args, result); } catch (_) { }
        return result;
      };
    }

    // ---- bindings (must run AFTER the call so result reflects new state)
    function targetBufKey(target) {
      switch (target) {
        case gl.ARRAY_BUFFER: return 'ARRAY_BUFFER';
        case gl.ELEMENT_ARRAY_BUFFER: return 'ELEMENT_ARRAY_BUFFER';
        case gl.UNIFORM_BUFFER: return 'UNIFORM_BUFFER';
        case gl.PIXEL_PACK_BUFFER: return 'PIXEL_PACK_BUFFER';
        case gl.PIXEL_UNPACK_BUFFER: return 'PIXEL_UNPACK_BUFFER';
        case gl.COPY_READ_BUFFER: return 'COPY_READ_BUFFER';
        case gl.COPY_WRITE_BUFFER: return 'COPY_WRITE_BUFFER';
        case gl.TRANSFORM_FEEDBACK_BUFFER: return 'TRANSFORM_FEEDBACK_BUFFER';
      }
      return null;
    }
    function targetTexKey(target) {
      switch (target) {
        case gl.TEXTURE_2D: return 'TEXTURE_2D';
        case gl.TEXTURE_CUBE_MAP: return 'TEXTURE_CUBE_MAP';
        case gl.TEXTURE_2D_ARRAY: return 'TEXTURE_2D_ARRAY';
        case gl.TEXTURE_3D: return 'TEXTURE_3D';
      }
      // cube map face targets all map to TEXTURE_CUBE_MAP binding
      if (target >= gl.TEXTURE_CUBE_MAP_POSITIVE_X &&
        target <= gl.TEXTURE_CUBE_MAP_NEGATIVE_Z) return 'TEXTURE_CUBE_MAP';
      return null;
    }
    function targetFbKey(target) {
      switch (target) {
        case gl.FRAMEBUFFER: return 'FRAMEBUFFER';
        case gl.READ_FRAMEBUFFER: return 'READ_FRAMEBUFFER';
        case gl.DRAW_FRAMEBUFFER: return 'DRAW_FRAMEBUFFER';
      }
      return null;
    }

    wrap('bindTexture', (a) => {
      const k = targetTexKey(a[0]);
      if (k) mem.bindings[k] = a[1] || null;
    });
    wrap('bindBuffer', (a) => {
      const k = targetBufKey(a[0]);
      if (k) mem.bindings[k] = a[1] || null;
    });
    wrap('bindFramebuffer', (a) => {
      const k = targetFbKey(a[0]);
      if (!k) return;
      mem.bindings[k] = a[1] || null;
      // FRAMEBUFFER target binds both READ and DRAW
      if (k === 'FRAMEBUFFER') {
        mem.bindings.READ_FRAMEBUFFER = a[1] || null;
        mem.bindings.DRAW_FRAMEBUFFER = a[1] || null;
      }
    });
    wrap('bindRenderbuffer', (a) => {
      mem.bindings.RENDERBUFFER = a[1] || null;
    });

    // Track an object: assign id, store mapping, register strong-ref or
    // finalizer based on current holdRefs. Returns the id (or undefined
    // if obj is null). idempotent: re-tracking returns existing id.
    //
    // Each entry also stores a WeakRef back to its GL object so that a
    // later OFF→ON toggle can re-pin still-alive objects. The WeakRef
    // itself does not keep the target alive.
    function track(obj, byMap, holdSet, idMap, initial) {
      if (!obj) return;
      let id = byMap.get(obj);
      if (id != null) return id;
      id = ++mem.nextId;
      byMap.set(obj, id);
      if (typeof WeakRef !== 'undefined') initial.ref = new WeakRef(obj);
      idMap.set(id, initial);
      if (holdRefs) holdSet.add(obj);
      else if (finReg) finReg.register(obj, { map: idMap, id }, obj);
      return id;
    }
    function untrack(obj, byMap, holdSet, idMap) {
      if (!obj) return;
      const id = byMap.get(obj);
      if (id == null) return;
      idMap.delete(id);
      holdSet.delete(obj);
      byMap.delete(obj);
      if (finReg) { try { finReg.unregister(obj); } catch (_) { } }
    }

    // ---- lifecycle: create/delete
    wrap('createTexture', (_a, r) => track(r, mem.texById, mem.texHold, mem.textures, { bytes: 0, stack: grabStack() }));
    wrap('createBuffer', (_a, r) => track(r, mem.bufById, mem.bufHold, mem.buffers, { bytes: 0, stack: grabStack() }));
    wrap('createRenderbuffer', (_a, r) => track(r, mem.rbById, mem.rbHold, mem.renderbuffers, { bytes: 0, stack: grabStack() }));
    wrap('createFramebuffer', (_a, r) => track(r, mem.fbById, mem.fbHold, mem.framebuffers, { attachments: {}, stack: grabStack() }));

    wrap('deleteTexture', (a) => untrack(a[0], mem.texById, mem.texHold, mem.textures));
    wrap('deleteBuffer', (a) => untrack(a[0], mem.bufById, mem.bufHold, mem.buffers));
    wrap('deleteRenderbuffer', (a) => untrack(a[0], mem.rbById, mem.rbHold, mem.renderbuffers));
    wrap('deleteFramebuffer', (a) => untrack(a[0], mem.fbById, mem.fbHold, mem.framebuffers));

    // ---- texture allocation
    function recordTex(tex, w, h, d, faces, fmt, levels, compressed, explicitBytes) {
      if (!tex) return;
      // Texture may not have been seen via createTexture (e.g. pre-existing).
      let id = mem.texById.get(tex);
      if (id == null) id = track(tex, mem.texById, mem.texHold, mem.textures, { bytes: 0 });
      let bytes;
      if (compressed && explicitBytes) bytes = explicitBytes;
      else { const base = w * h * d * faces * bppFor(fmt); bytes = mipBytes(base, levels || 1); }
      const prev = mem.textures.get(id) || {};
      mem.textures.set(id, {
        w, h, d, faces, format: fmt,
        formatName: fmtName(fmt),
        levels: levels || 1, bytes,
        compressed: !!compressed,
        bpp: bppFor(fmt),
        createdAt: prev.createdAt || performance.now(),
        stack: grabStack() || prev.stack,
        ref: prev.ref
      });
    }

    wrap('texImage2D', (a) => {
      const target = a[0], level = a[1], internalformat = a[2];
      // texImage2D has two argument shapes:
      //   6-arg source form: (target, level, internalformat, format, type, source)
      //   9-arg explicit:    (target, level, internalformat, w, h, border, format, type, src|pixels|pboOffset)
      // Both have a number at a[3], so we MUST disambiguate by length, not type.
      let w, h;
      if (a.length === 6) {
        const src = a[5];
        if (src) {
          w = src.width || src.videoWidth || src.naturalWidth || src.codedWidth;
          h = src.height || src.videoHeight || src.naturalHeight || src.codedHeight;
        }
      } else if (a.length >= 9) {
        w = a[3]; h = a[4];
      }
      if (level !== 0 || !w || !h) return;
      const k = targetTexKey(target); if (!k) return;
      const tex = mem.bindings[k];
      const isCube = (k === 'TEXTURE_CUBE_MAP');
      recordTex(tex, w, h, 1, isCube ? 6 : 1, internalformat, 1);
    });

    wrap('texImage3D', (a) => {
      const [target, level, internalformat, w, h, d] = a;
      if (level !== 0) return;
      const k = targetTexKey(target); if (!k) return;
      recordTex(mem.bindings[k], w, h, d, 1, internalformat, 1);
    });

    wrap('texStorage2D', (a) => {
      const [target, levels, internalformat, w, h] = a;
      const k = targetTexKey(target); if (!k) return;
      const isCube = (k === 'TEXTURE_CUBE_MAP');
      recordTex(mem.bindings[k], w, h, 1, isCube ? 6 : 1, internalformat, levels);
    });

    wrap('texStorage3D', (a) => {
      const [target, levels, internalformat, w, h, d] = a;
      const k = targetTexKey(target); if (!k) return;
      recordTex(mem.bindings[k], w, h, d, 1, internalformat, levels);
    });

    wrap('compressedTexImage2D', (a) => {
      const [target, level, internalformat, w, h, , dataOrSize] = a;
      if (level !== 0) return;
      const k = targetTexKey(target); if (!k) return;
      const isCube = (k === 'TEXTURE_CUBE_MAP');
      const bytes = (typeof dataOrSize === 'number') ? dataOrSize : (dataOrSize?.byteLength || 0);
      recordTex(mem.bindings[k], w, h, 1, isCube ? 6 : 1, internalformat, 1, true, bytes);
    });

    wrap('compressedTexImage3D', (a) => {
      const [target, level, internalformat, w, h, d, , dataOrSize] = a;
      if (level !== 0) return;
      const k = targetTexKey(target); if (!k) return;
      const bytes = (typeof dataOrSize === 'number') ? dataOrSize : (dataOrSize?.byteLength || 0);
      recordTex(mem.bindings[k], w, h, d, 1, internalformat, 1, true, bytes);
    });

    wrap('copyTexImage2D', (a) => {
      const [target, level, internalformat, , , w, h] = a;
      if (level !== 0) return;
      const k = targetTexKey(target); if (!k) return;
      const isCube = (k === 'TEXTURE_CUBE_MAP');
      recordTex(mem.bindings[k], w, h, 1, isCube ? 6 : 1, internalformat, 1);
    });

    wrap('generateMipmap', (a) => {
      const k = targetTexKey(a[0]); if (!k) return;
      const tex = mem.bindings[k]; if (!tex) return;
      const id = mem.texById.get(tex); if (id == null) return;
      const e = mem.textures.get(id); if (!e || !e.bytes) return;
      // Replace bytes with full chain estimate (only if currently single-level)
      if (!e.levels || e.levels <= 1) {
        e.bytes = Math.ceil((e.bytes) * MIP_CHAIN_FACTOR);
        e.levels = Math.max(1, Math.floor(Math.log2(Math.max(e.w || 1, e.h || 1))) + 1);
        mem.textures.set(id, e);
      }
    });

    // ---- buffer allocation
    wrap('bufferData', (a) => {
      const [target, sizeOrData, usage] = a;
      const k = targetBufKey(target); if (!k) return;
      const buf = mem.bindings[k]; if (!buf) return;
      let id = mem.bufById.get(buf);
      if (id == null) id = track(buf, mem.bufById, mem.bufHold, mem.buffers, { bytes: 0 });
      let size = 0;
      if (typeof sizeOrData === 'number') size = sizeOrData;
      else if (sizeOrData && sizeOrData.byteLength != null) size = sizeOrData.byteLength;
      const prev = mem.buffers.get(id) || {};
      mem.buffers.set(id, { size, bytes: size, usage, target, stack: grabStack() || prev.stack, ref: prev.ref });
    });

    // ---- renderbuffer allocation
    wrap('renderbufferStorage', (a) => {
      const [, internalformat, w, h] = a;
      const r = mem.bindings.RENDERBUFFER; if (!r) return;
      let id = mem.rbById.get(r);
      if (id == null) id = track(r, mem.rbById, mem.rbHold, mem.renderbuffers, { bytes: 0 });
      const prev = mem.renderbuffers.get(id) || {};
      const bytes = w * h * bppFor(internalformat);
      mem.renderbuffers.set(id, { w, h, format: internalformat, formatName: fmtName(internalformat), samples: 1, bytes, stack: grabStack() || prev.stack, ref: prev.ref });
    });
    wrap('renderbufferStorageMultisample', (a) => {
      const [, samples, internalformat, w, h] = a;
      const r = mem.bindings.RENDERBUFFER; if (!r) return;
      let id = mem.rbById.get(r);
      if (id == null) id = track(r, mem.rbById, mem.rbHold, mem.renderbuffers, { bytes: 0 });
      const prev = mem.renderbuffers.get(id) || {};
      const bytes = w * h * bppFor(internalformat) * Math.max(1, samples);
      mem.renderbuffers.set(id, { w, h, format: internalformat, formatName: fmtName(internalformat), samples, bytes, stack: grabStack() || prev.stack, ref: prev.ref });
    });

    // ---- framebuffer topology
    function attachmentName(att) {
      const t = {
        [gl.COLOR_ATTACHMENT0]: 'COLOR_ATTACHMENT0',
        [gl.DEPTH_ATTACHMENT]: 'DEPTH_ATTACHMENT',
        [gl.STENCIL_ATTACHMENT]: 'STENCIL_ATTACHMENT',
        [gl.DEPTH_STENCIL_ATTACHMENT]: 'DEPTH_STENCIL_ATTACHMENT'
      };
      if (gl.COLOR_ATTACHMENT1 !== undefined) {
        for (let i = 0; i < 16; i++) {
          const e = gl['COLOR_ATTACHMENT' + i];
          if (e !== undefined) t[e] = 'COLOR_ATTACHMENT' + i;
        }
      }
      return t[att] || ('0x' + (att | 0).toString(16));
    }
    // Framebuffer attachments store the *id* of the attached object
    // (not the object itself) so the framebuffer entry doesn't pin the
    // attached texture/renderbuffer alive when holdRefs=false.
    wrap('framebufferTexture2D', (a) => {
      const [target, attachment, , tex, level] = a;
      const fbKey = targetFbKey(target); if (!fbKey) return;
      const fb = mem.bindings[fbKey]; if (!fb) return;
      const fbId = mem.fbById.get(fb); if (fbId == null) return;
      const e = mem.framebuffers.get(fbId) || { attachments: {} };
      e.attachments[attachmentName(attachment)] = { kind: 'texture', texId: tex ? mem.texById.get(tex) : null, level };
      mem.framebuffers.set(fbId, e);
    });
    wrap('framebufferTextureLayer', (a) => {
      const [target, attachment, tex, level, layer] = a;
      const fbKey = targetFbKey(target); if (!fbKey) return;
      const fb = mem.bindings[fbKey]; if (!fb) return;
      const fbId = mem.fbById.get(fb); if (fbId == null) return;
      const e = mem.framebuffers.get(fbId) || { attachments: {} };
      e.attachments[attachmentName(attachment)] = { kind: 'texture', texId: tex ? mem.texById.get(tex) : null, level, layer };
      mem.framebuffers.set(fbId, e);
    });
    wrap('framebufferRenderbuffer', (a) => {
      const [target, attachment, , rb] = a;
      const fbKey = targetFbKey(target); if (!fbKey) return;
      const fb = mem.bindings[fbKey]; if (!fb) return;
      const fbId = mem.fbById.get(fb); if (fbId == null) return;
      const e = mem.framebuffers.get(fbId) || { attachments: {} };
      e.attachments[attachmentName(attachment)] = { kind: 'renderbuffer', rbId: rb ? mem.rbById.get(rb) : null };
      mem.framebuffers.set(fbId, e);
    });

    return gl;
  }

  // ------------------------------------------------------------------
  // getContext patch (the magic that makes this universal)
  // ------------------------------------------------------------------
  function patchGetContext(Proto) {
    if (!Proto || !Proto.prototype || Proto.prototype.__memPatched) return;
    const orig = Proto.prototype.getContext;
    if (typeof orig !== 'function') return;
    Proto.prototype.getContext = function (type, attrs) {
      const ctx = orig.call(this, type, attrs);
      if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
        try { installHooks(ctx); } catch (e) { console.warn('[gpuMem] hook install failed:', e); }
      }
      return ctx;
    };
    Proto.prototype.__memPatched = true;
  }

  if (typeof HTMLCanvasElement !== 'undefined') patchGetContext(HTMLCanvasElement);
  if (typeof OffscreenCanvas !== 'undefined') patchGetContext(OffscreenCanvas);

  // ------------------------------------------------------------------
  // Reporter
  // ------------------------------------------------------------------
  function summarizeContext(gl, opts) {
    const mem = gl.__mem;
    let texBytes = 0, bufBytes = 0, rbBytes = 0;
    const textures = [], buffers = [], renderbuffers = [], framebuffers = [];
    let texUnknown = 0, bufUnknown = 0;

    let i = 0;
    for (const [, e] of mem.textures) {
      if (e && e.bytes) texBytes += e.bytes; else texUnknown++;
      textures.push({
        idx: i++, w: e.w ?? null, h: e.h ?? null, d: e.d ?? null,
        faces: e.faces ?? null, levels: e.levels ?? null,
        format: e.formatName ?? null, bpp: e.bpp ?? null,
        bytes: e.bytes || 0, compressed: !!e.compressed,
        stack: e.stack || null
      });
    }
    i = 0;
    for (const [, e] of mem.buffers) {
      if (e && e.bytes) bufBytes += e.bytes; else bufUnknown++;
      buffers.push({ idx: i++, size: e.size ?? null, usage: e.usage ?? null, stack: e.stack || null });
    }
    i = 0;
    for (const [, e] of mem.renderbuffers) {
      if (e && e.bytes) rbBytes += e.bytes;
      renderbuffers.push({
        idx: i++, w: e.w ?? null, h: e.h ?? null,
        format: e.formatName ?? null, samples: e.samples ?? null, bytes: e.bytes || 0,
        stack: e.stack || null
      });
    }
    i = 0;
    for (const [, e] of mem.framebuffers) {
      framebuffers.push({
        idx: i++, attachments: Object.entries(e.attachments || {})
          .map(([k, v]) => ({ attachment: k, kind: v.kind })), stack: e.stack || null
      });
    }

    return {
      label: mem.label,
      isWebGL2: mem.isWebGL2,
      canvas: { width: gl.canvas?.width, height: gl.canvas?.height },
      summary: {
        textureBytes: texBytes,
        bufferBytes: bufBytes,
        renderbufferBytes: rbBytes,
        totalBytes: texBytes + bufBytes + rbBytes,
        texturesMB: +(texBytes / 1048576).toFixed(2),
        buffersMB: +(bufBytes / 1048576).toFixed(2),
        renderbuffersMB: +(rbBytes / 1048576).toFixed(2),
        totalMB: +((texBytes + bufBytes + rbBytes) / 1048576).toFixed(2)
      },
      counts: {
        textures: mem.textures.size,
        buffers: mem.buffers.size,
        renderbuffers: mem.renderbuffers.size,
        framebuffers: mem.framebuffers.size
      },
      coverage: {
        textures: { tracked: mem.textures.size - texUnknown, unsized: texUnknown },
        buffers: { tracked: mem.buffers.size - bufUnknown, unsized: bufUnknown }
      },
      textures: opts.verbose ? textures : textures.slice(0, 10),
      buffers: opts.verbose ? buffers : buffers.slice(0, 10),
      renderbuffers,
      framebuffers
    };
  }

  function gpuMemReport(opts) {
    opts = Object.assign({ verbose: false, perContext: false, canvas: null }, opts || {});
    const ctxs = [];
    for (const gl of REG.contexts) {
      if (opts.canvas && gl.canvas !== opts.canvas) continue;
      ctxs.push(gl);
    }
    if (ctxs.length === 0) {
      return {
        warning: 'No WebGL contexts have been hooked. ' +
          'gpu_memory.js must be loaded before the app calls getContext(). ' +
          'For pre-existing contexts, call window.installGpuMemHooks(gl) manually.',
        contexts: 0
      };
    }
    const per = ctxs.map(gl => summarizeContext(gl, opts));
    let texB = 0, bufB = 0, rbB = 0;
    let nTex = 0, nBuf = 0, nRb = 0, nFb = 0;
    for (const c of per) {
      texB += c.summary.textureBytes;
      bufB += c.summary.bufferBytes;
      rbB += c.summary.renderbufferBytes;
      nTex += c.counts.textures; nBuf += c.counts.buffers;
      nRb += c.counts.renderbuffers; nFb += c.counts.framebuffers;
    }
    const totalB = texB + bufB + rbB;
    const out = {
      contexts: per.length,
      holdRefs,
      captureStacks,
      summary: {
        textureBytes: texB,
        bufferBytes: bufB,
        renderbufferBytes: rbB,
        totalBytes: totalB,
        texturesMB: +(texB / 1048576).toFixed(2),
        buffersMB: +(bufB / 1048576).toFixed(2),
        renderbuffersMB: +(rbB / 1048576).toFixed(2),
        totalMB: +(totalB / 1048576).toFixed(2)
      },
      counts: { textures: nTex, buffers: nBuf, renderbuffers: nRb, framebuffers: nFb }
    };
    if (opts.perContext || per.length === 1) out.perContext = per;
    return out;
  }

  // ------------------------------------------------------------------
  // Reference-holding policy toggle.
  //
  // ON→OFF: drop strong refs, register every still-tracked object with
  //         the FinalizationRegistry so its bookkeeping entry is cleaned
  //         up after GC reclaims the wrapper.
  // OFF→ON: walk every entry's WeakRef; for each one that's still alive
  //         (i.e. the app or driver state still holds the object),
  //         re-pin it in the hold Set and unregister its finalizer so
  //         we no longer rely on GC. Entries whose WeakRef has died
  //         are dropped (the finalizer would have already done this,
  //         but we sweep here in case GC hasn't run yet).
  // ------------------------------------------------------------------
  function setHoldRefs(on) {
    on = !!on;
    if (on === holdRefs) return on;
    holdRefs = on;
    for (const gl of REG.contexts) {
      const m = gl.__mem; if (!m) continue;
      if (!on) {
        // ON → OFF: release strong holds, arm finalizers.
        const release = (holdSet, byMap, idMap) => {
          if (!finReg) { holdSet.clear(); return; }
          for (const obj of holdSet) {
            const id = byMap.get(obj);
            if (id != null) finReg.register(obj, { map: idMap, id }, obj);
          }
          holdSet.clear();
        };
        release(m.texHold, m.texById, m.textures);
        release(m.bufHold, m.bufById, m.buffers);
        release(m.rbHold, m.rbById, m.renderbuffers);
        release(m.fbHold, m.fbById, m.framebuffers);
      } else {
        // OFF → ON: re-pin still-alive entries via WeakRef.
        const repin = (holdSet, idMap) => {
          for (const [id, e] of idMap) {
            const obj = e && e.ref && e.ref.deref ? e.ref.deref() : null;
            if (obj) {
              holdSet.add(obj);
              if (finReg) { try { finReg.unregister(obj); } catch (_) { } }
            } else {
              // Wrapper already collected; entry is stale, drop it.
              idMap.delete(id);
            }
          }
        };
        repin(m.texHold, m.textures);
        repin(m.bufHold, m.buffers);
        repin(m.rbHold, m.renderbuffers);
        repin(m.fbHold, m.framebuffers);
      }
    }
    return on;
  }
  function getHoldRefs() { return holdRefs; }

  function setCaptureStacks(on) { captureStacks = !!on; return captureStacks; }
  function getCaptureStacks() { return captureStacks; }

  // ------------------------------------------------------------------
  // Expose
  // ------------------------------------------------------------------
  G.gpuMemReport = gpuMemReport;
  G.installGpuMemHooks = installHooks;
  G.gpuMemSetHoldRefs = setHoldRefs;
  G.gpuMemGetHoldRefs = getHoldRefs;
  G.gpuMemSetCaptureStacks = setCaptureStacks;
  G.gpuMemGetCaptureStacks = getCaptureStacks;

  // Helpful console banner
  try {
    console.log('%c[gpuMem v0.1]%c installed. Call gpuMemReport() any time.',
      'background:#222;color:#bada55;padding:2px 6px;border-radius:3px',
      'color:inherit');
  } catch (_) { }
})();
