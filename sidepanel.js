// =============================================================================
// sidepanel.js — hierarchical GPU memory report viewer
//
// Tree:
//   Total
//     ├─ Context #1 (canvas info, total)
//     │    ├─ Textures (count, total)
//     │    │    └─ table of every texture w/h/format/bytes
//     │    ├─ Buffers (count, total)
//     │    │    └─ table of every buffer
//     │    ├─ Renderbuffers
//     │    └─ Framebuffers (topology)
//     └─ Context #2 ...
// =============================================================================

const $ = (s) => document.querySelector(s);
const content = $('#content');
const totalMem = $('#totalMem');
const breakdown = $('#breakdown');
const ctxCount = $('#ctxCount');

let lastReport = null;
let showRaw = false;

// Track which <details> are open so re-renders (auto-refresh) don't collapse them.
const openKeys = new Set();
const seenKeys = new Set();

// Track which per-row stack views are expanded. Keyed by
// `<group-key>:<row-idx>` (e.g. "ctx:0/tex:3").
const stackOpenKeys = new Set();

// Per-table sort state. Keyed by table `keyPrefix` -> { col, dir }.
// `col` is a column `key` from the column-spec; `dir` is 'asc'|'desc'.
// Cleared on tab switch alongside openKeys / stackOpenKeys.
const tableSort = new Map();

// GL buffer-usage enum decoder. Showing names like STATIC_DRAW is much
// more useful than raw hex values; the hex stays accessible via tooltip.
const GL_USAGE = {
    0x88E0: 'STREAM_DRAW', 0x88E1: 'STREAM_READ', 0x88E2: 'STREAM_COPY',
    0x88E4: 'STATIC_DRAW', 0x88E5: 'STATIC_READ', 0x88E6: 'STATIC_COPY',
    0x88E8: 'DYNAMIC_DRAW', 0x88E9: 'DYNAMIC_READ', 0x88EA: 'DYNAMIC_COPY',
};
function usageName(n) {
    if (n == null) return '—';
    return GL_USAGE[n] || ('0x' + Number(n).toString(16));
}
function usageHex(n) {
    if (n == null) return null;
    return '0x' + Number(n).toString(16);
}

// ---- formatters ------------------------------------------------------------
function fmtBytes(bytes) {
    if (bytes == null) return '—';
    if (bytes === 0) return '0 B';
    const abs = Math.abs(bytes);
    if (abs < 1024) return bytes + ' B';
    if (abs < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (abs < 1024 ** 3) return (bytes / 1048576).toFixed(2) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}
function fmtMB(bytes) {
    // best-unit but biased toward MB for totals
    if (bytes == null) return '—';
    if (bytes === 0) return '0 MB';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
}
function dimStr(t) {
    if (t.w == null) return '—';
    let s = t.w + '×' + t.h;
    if (t.d && t.d > 1) s += '×' + t.d;
    if (t.faces && t.faces > 1) s += ' (×' + t.faces + ' faces)';
    if (t.levels && t.levels > 1) s += '  ' + t.levels + ' mips';
    return s;
}
// Verbose tooltip for the dimensions cell.
function dimTitle(t) {
    if (t.w == null) return null;
    const parts = ['width: ' + t.w, 'height: ' + t.h];
    if (t.d && t.d > 1) parts.push('depth: ' + t.d);
    if (t.faces && t.faces > 1) parts.push('faces: ' + t.faces);
    if (t.levels && t.levels > 1) parts.push('mip levels: ' + t.levels);
    if (t.compressed) parts.push('compressed');
    return parts.join('\n');
}
// Total pixel count for sorting textures by 'dimensions'.
function texPixels(t) {
    if (t.w == null) return 0;
    return (t.w | 0) * (t.h | 0) * Math.max(1, t.d | 0 || 1) * Math.max(1, t.faces | 0 || 1);
}
function pct(part, whole) {
    if (!whole) return '0%';
    return (100 * part / whole).toFixed(1) + '%';
}

// ---- DOM helpers -----------------------------------------------------------
function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
        if (k === 'class') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
    }
    if (children) for (const c of children) {
        if (c == null) continue;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
}
function summaryNode(name, meta, sizeText, opts) {
    const metaProps = { class: 'summary-meta', text: meta || '' };
    if (opts?.metaTitle) metaProps.title = opts.metaTitle;
    return el('summary', null, [
        el('span', { class: 'summary-line' }, [
            el('span', { class: 'summary-name', text: name }),
            el('span', metaProps),
            el('span', { class: 'summary-size' + (opts?.zero ? ' zero' : ''), text: sizeText })
        ])
    ]);
}

// ---- column-spec table builders --------------------------------------------
//
// Each renderer (textures/buffers/renderbuffers) declares an array of column
// descriptors instead of inlining its <thead> + cell logic. A column is:
//   { key, label, numeric?, sortVal?, cell }
// `cell(row, idx)` returns a <td>. `sortVal(row)` returns a primitive used
// for ordering (numbers for numeric cols, lowercased strings for text).
// Omitting `sortVal` makes the column non-sortable (the '#' index column).

// Stable, null-last sort. Returns a shallow copy if a sort is active.
function sortRows(rows, keyPrefix, columns) {
    const s = tableSort.get(keyPrefix);
    if (!s) return rows;
    const col = columns.find(c => c.key === s.col);
    if (!col || !col.sortVal) return rows;
    const sign = s.dir === 'asc' ? 1 : -1;
    // decorate-sort-undecorate for stable ordering
    return rows
        .map((r, i) => ({ r, i, v: col.sortVal(r) }))
        .sort((a, b) => {
            const av = a.v, bv = b.v;
            const an = av == null, bn = bv == null;
            if (an && bn) return a.i - b.i;
            if (an) return 1;          // nulls always last
            if (bn) return -1;
            if (av < bv) return -1 * sign;
            if (av > bv) return 1 * sign;
            return a.i - b.i;          // stable
        })
        .map(x => x.r);
}

function makeHeader(columns, keyPrefix) {
    const s = tableSort.get(keyPrefix);
    return el('thead', null, [
        el('tr', null, columns.map(col => {
            const cls = [];
            if (col.numeric) cls.push('num');
            const sortable = !!col.sortVal;
            if (sortable) cls.push('sortable');
            const isSorted = sortable && s && s.col === col.key;
            if (isSorted) cls.push('sorted');
            const arrow = isSorted ? (s.dir === 'asc' ? ' ▲' : ' ▼') : '';
            const th = el('th', { class: cls.join(' '), text: col.label + arrow });
            if (sortable) {
                th.addEventListener('click', () => {
                    const cur = tableSort.get(keyPrefix);
                    if (cur && cur.col === col.key) {
                        // flip direction; remove sort entirely on third click
                        if (cur.dir === 'desc') tableSort.set(keyPrefix, { col: col.key, dir: 'asc' });
                        else tableSort.delete(keyPrefix);
                    } else {
                        // first click: numeric defaults desc (largest first), text asc
                        tableSort.set(keyPrefix, { col: col.key, dir: col.numeric ? 'desc' : 'asc' });
                    }
                    if (lastReport) renderReport(lastReport);
                });
            }
            return th;
        }))
    ]);
}

// Build a complete table from a column spec.
function makeTable(rows, columns, keyPrefix, emptyText) {
    if (!rows || rows.length === 0) return el('div', { class: 'empty', text: emptyText });
    const sorted = sortRows(rows, keyPrefix, columns);
    return el('table', null, [
        makeHeader(columns, keyPrefix),
        makeBody(sorted, columns.length, (r, i) => columns.map(col => col.cell(r, i)), keyPrefix)
    ]);
}

// ---- renderers per resource type -------------------------------------------

// Build a tbody with optional click-to-expand stack rows.
// `keyPrefix` is used to make stack-open state survive re-renders.
function makeBody(rows, colCount, mkCells, keyPrefix) {
    const tbody = el('tbody');
    rows.forEach((r, i) => {
        const tr = el('tr', null, mkCells(r, i));
        if (r.stack) {
            const sKey = (keyPrefix || '') + ':' + (r.idx ?? i);
            const wasOpen = stackOpenKeys.has(sKey);
            tr.classList.add('has-stack');
            if (wasOpen) tr.classList.add('open');
            const stackTr = el('tr',
                { class: 'stack-row', style: 'display:' + (wasOpen ? '' : 'none') + ';' },
                [el('td', { colspan: String(colCount) }, [
                    el('pre', { class: 'stack', text: r.stack })
                ])]);
            tr.addEventListener('click', () => {
                const open = stackTr.style.display !== 'none';
                stackTr.style.display = open ? 'none' : '';
                tr.classList.toggle('open', !open);
                if (open) stackOpenKeys.delete(sKey); else stackOpenKeys.add(sKey);
            });
            tbody.appendChild(tr);
            tbody.appendChild(stackTr);
        } else {
            tbody.appendChild(tr);
        }
    });
    return tbody;
}

function renderTextures(textures, keyPrefix) {
    const cols = [
        { key: 'idx', label: '#', numeric: false, cell: (t, i) => el('td', { text: String(t.idx ?? i) }) },
        {
            key: 'dim', label: 'dimensions', sortVal: texPixels,
            cell: (t) => {
                const props = { text: dimStr(t) };
                const tip = dimTitle(t);
                if (tip) props.title = tip;
                return el('td', props);
            }
        },
        { key: 'fmt', label: 'format', sortVal: (t) => (t.format || '').toLowerCase(), cell: (t) => el('td', { text: t.format || '—' }) },
        { key: 'bpp', label: 'bpp', numeric: true, sortVal: (t) => (t.bpp == null ? null : t.bpp), cell: (t) => el('td', { class: 'num', text: t.bpp != null ? String(t.bpp) : '—' }) },
        { key: 'size', label: 'size', numeric: true, sortVal: (t) => t.bytes || 0, cell: (t) => el('td', { class: 'num size', text: fmtBytes(t.bytes) }) }
    ];
    return makeTable(textures, cols, keyPrefix, 'no textures');
}

function renderBuffers(buffers, keyPrefix) {
    const cols = [
        { key: 'idx', label: '#', cell: (b, i) => el('td', { text: String(b.idx ?? i) }) },
        {
            key: 'usage', label: 'usage', sortVal: (b) => usageName(b.usage),
            cell: (b) => {
                const props = { text: usageName(b.usage) };
                const hex = usageHex(b.usage);
                if (hex && GL_USAGE[b.usage]) props.title = hex;
                return el('td', props);
            }
        },
        { key: 'size', label: 'size', numeric: true, sortVal: (b) => b.size || 0, cell: (b) => el('td', { class: 'num size', text: fmtBytes(b.size) }) }
    ];
    return makeTable(buffers, cols, keyPrefix, 'no buffers');
}

function renderRenderbuffers(rbs, keyPrefix) {
    const cols = [
        { key: 'idx', label: '#', cell: (r, i) => el('td', { text: String(r.idx ?? i) }) },
        { key: 'dim', label: 'dimensions', sortVal: (r) => (r.w | 0) * (r.h | 0), cell: (r) => el('td', { text: r.w + '×' + r.h }) },
        { key: 'fmt', label: 'format', sortVal: (r) => (r.format || '').toLowerCase(), cell: (r) => el('td', { text: r.format || '—' }) },
        { key: 'samples', label: 'samples', numeric: true, sortVal: (r) => r.samples || 1, cell: (r) => el('td', { class: 'num', text: String(r.samples || 1) }) },
        { key: 'size', label: 'size', numeric: true, sortVal: (r) => r.bytes || 0, cell: (r) => el('td', { class: 'num size', text: fmtBytes(r.bytes) }) }
    ];
    return makeTable(rbs, cols, keyPrefix, 'no renderbuffers');
}

function renderFramebuffers(fbs, keyPrefix) {
    // Framebuffers stay un-sortable: only one meaningful column.
    const cols = [
        { key: 'idx', label: '#', cell: (f, i) => el('td', { text: String(f.idx ?? i) }) },
        { key: 'attach', label: 'attachments', cell: (f) => el('td', { text: (f.attachments || []).map(a => a.attachment + ':' + a.kind).join(', ') || '—' }) }
    ];
    return makeTable(fbs, cols, keyPrefix, 'no framebuffers');
}

// ---- per-resource group (Textures / Buffers / RBs / FBOs) ------------------
function resourceGroup(key, label, count, totalBytes, listEl) {
    const summary = summaryNode(
        label,
        count + ' ' + (count === 1 ? 'item' : 'items'),
        fmtMB(totalBytes),
        { zero: !totalBytes }
    );
    const props = { 'data-key': key };
    if (openKeys.has(key)) props.open = '';
    const d = el('details', props, [
        summary,
        el('div', { class: 'nested' }, [listEl])
    ]);
    d.addEventListener('toggle', () => {
        if (d.open) openKeys.add(key); else openKeys.delete(key);
    });
    return d;
}

// ---- per-context block ----------------------------------------------------
function contextBlock(c, idx) {
    // Prefer raw bytes (newer report format) over rounded MB
    const texBytes = c.summary.textureBytes ?? Math.round((c.summary.texturesMB || 0) * 1048576);
    const bufBytes = c.summary.bufferBytes ?? Math.round((c.summary.buffersMB || 0) * 1048576);
    const rbBytes = c.summary.renderbufferBytes ?? Math.round((c.summary.renderbuffersMB || 0) * 1048576);
    const totalBytes = c.summary.totalBytes ?? (texBytes + bufBytes + rbBytes);

    const label = (c.label || 'canvas') +
        (c.canvas ? `  ${c.canvas.width}×${c.canvas.height}` : '') +
        (c.isWebGL2 ? '  WebGL2' : '  WebGL1');

    const meta = `tex:${c.counts.textures}  buf:${c.counts.buffers}  rb:${c.counts.renderbuffers}  fbo:${c.counts.framebuffers}`;
    // Verbose tooltip spelling out each shorthand.
    const metaTitle =
        `Textures: ${c.counts.textures} (${fmtMB(texBytes)})\n` +
        `Buffers: ${c.counts.buffers} (${fmtMB(bufBytes)})\n` +
        `Renderbuffers: ${c.counts.renderbuffers} (${fmtMB(rbBytes)})\n` +
        `Framebuffers: ${c.counts.framebuffers}`;

    const ctxKey = 'ctx:' + idx;
    const groups = el('div', { class: 'nested' }, [
        resourceGroup(ctxKey + '/tex', 'Textures', c.counts.textures, texBytes, renderTextures(c.textures, ctxKey + '/tex')),
        resourceGroup(ctxKey + '/buf', 'Buffers', c.counts.buffers, bufBytes, renderBuffers(c.buffers, ctxKey + '/buf')),
        resourceGroup(ctxKey + '/rb', 'Renderbuffers', c.counts.renderbuffers, rbBytes, renderRenderbuffers(c.renderbuffers, ctxKey + '/rb')),
        resourceGroup(ctxKey + '/fbo', 'Framebuffers', c.counts.framebuffers, 0, renderFramebuffers(c.framebuffers, ctxKey + '/fbo'))
    ]);

    // Default-open contexts on first render only. Use stable key to remember state.
    const props = { 'data-key': ctxKey };
    // Default to open if we've never seen this key before
    if (!seenKeys.has(ctxKey)) { openKeys.add(ctxKey); seenKeys.add(ctxKey); }
    if (openKeys.has(ctxKey)) props.open = '';
    const det = el('details', props, [
        summaryNode('Context #' + (idx + 1) + ' — ' + label, meta, fmtMB(totalBytes), { metaTitle }),
        groups
    ]);
    det.addEventListener('toggle', () => {
        if (det.open) openKeys.add(ctxKey); else openKeys.delete(ctxKey);
    });
    return det;
}

// ---- top-level render -----------------------------------------------------
function renderReport(report) {
    // Preserve scroll position across re-render
    const scroller = document.scrollingElement || document.documentElement;
    const savedScroll = scroller.scrollTop;

    content.innerHTML = '';
    if (!report) {
        content.appendChild(el('div', { class: 'empty', text: 'No data.' }));
        return;
    }
    if (report.error) {
        content.appendChild(el('div', { class: 'err-msg', text: report.error }));
        totalMem.textContent = '—';
        breakdown.textContent = 'error';
        ctxCount.textContent = '—';
        return;
    }
    if (report.warning) {
        content.appendChild(el('div', { class: 'warn-msg', text: report.warning }));
        totalMem.textContent = '0';
        breakdown.textContent = 'no contexts hooked yet';
        ctxCount.textContent = '0 ctx';
        return;
    }

    ctxCount.textContent = report.contexts + ' ctx';
    ctxCount.title = report.contexts + ' hooked WebGL context' + (report.contexts === 1 ? '' : 's');
    // Reflect actual toggle state from the page (in case it was set elsewhere,
    // or because we just switched tabs and the new tab has different settings).
    if (typeof report.holdRefs === 'boolean') {
        const cb = $('#holdRefs');
        if (cb && cb.checked !== report.holdRefs) cb.checked = report.holdRefs;
    }
    if (typeof report.captureStacks === 'boolean') {
        const cb = $('#captureStacks');
        if (cb && cb.checked !== report.captureStacks) cb.checked = report.captureStacks;
    }
    const totalBytes = report.summary.totalBytes ?? Math.round((report.summary.totalMB || 0) * 1048576);
    totalMem.textContent = fmtMB(totalBytes);
    const texB = report.summary.textureBytes ?? Math.round((report.summary.texturesMB || 0) * 1048576);
    const bufB = report.summary.bufferBytes ?? Math.round((report.summary.buffersMB || 0) * 1048576);
    const rbB = report.summary.renderbufferBytes ?? Math.round((report.summary.renderbuffersMB || 0) * 1048576);
    breakdown.textContent =
        `tex ${fmtMB(texB)} · buf ${fmtMB(bufB)} · rb ${fmtMB(rbB)}   |   ` +
        `${report.counts.textures}T  ${report.counts.buffers}B  ${report.counts.renderbuffers}R  ${report.counts.framebuffers}F`;
    breakdown.title =
        `Textures: ${report.counts.textures} (${fmtMB(texB)})\n` +
        `Buffers: ${report.counts.buffers} (${fmtMB(bufB)})\n` +
        `Renderbuffers: ${report.counts.renderbuffers} (${fmtMB(rbB)})\n` +
        `Framebuffers: ${report.counts.framebuffers}`;

    const ctxs = report.perContext || [];
    if (ctxs.length === 0) {
        content.appendChild(el('div', {
            class: 'empty',
            text: 'No per-context details (gpuMemReport returned aggregated only).'
        }));
        return;
    }
    ctxs.forEach((c, i) => content.appendChild(contextBlock(c, i)));

    if (showRaw) {
        content.appendChild(el('pre', { class: 'raw', text: JSON.stringify(report, null, 2) }));
    }

    // Restore scroll. rAF ensures layout has settled.
    requestAnimationFrame(() => { scroller.scrollTop = savedScroll; });
}

// ---- runner ---------------------------------------------------------------
async function run() {
    // Only show "scanning" placeholder if we have nothing rendered yet,
    // to avoid scroll/state reset on auto-refresh.
    if (!lastReport) {
        content.innerHTML = '';
        content.appendChild(el('div', { class: 'empty', text: '...scanning active tab...' }));
    }
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) throw new Error('no active tab');
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: false },
            world: 'MAIN',
            func: (o) => {
                if (typeof gpuMemReport !== 'function') {
                    return { error: 'gpuMemReport not found on this page. Reload the tab — the extension hooks WebGL at document_start, so it must be loaded before the page initializes.' };
                }
                try { return { result: gpuMemReport(o) }; }
                catch (e) { return { error: String((e && e.stack) || e) }; }
            },
            args: [{ verbose: true, perContext: true }]
        });
        if (result && result.error) { lastReport = { error: result.error }; renderReport(lastReport); return; }
        if (result && result.result) { lastReport = result.result; renderReport(lastReport); return; }
        lastReport = { error: 'No result returned from page.' };
        renderReport(lastReport);
    } catch (e) {
        lastReport = { error: 'Extension error: ' + e.message };
        renderReport(lastReport);
    }
}

// ---- toolbar bindings -----------------------------------------------------
$('#refresh').addEventListener('click', run);
$('#copy').addEventListener('click', async () => {
    if (!lastReport) return;
    try {
        await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
        const btn = $('#copy');
        const t = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => btn.textContent = t, 1200);
    } catch (e) { /* no-op */ }
});
$('#toggleRaw').addEventListener('click', () => {
    showRaw = !showRaw;
    if (lastReport) renderReport(lastReport);
});

let autoTimer = null;
$('#autoRefresh').addEventListener('change', (e) => {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (e.target.checked) autoTimer = setInterval(run, 2000);
});

// Hold-refs toggle: ON = leak detector (default); OFF = let GC reclaim
// dropped GL objects so real GPU bugs surface in app code.
$('#holdRefs').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;
        await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: 'MAIN',
            func: (v) => { if (typeof gpuMemSetHoldRefs === 'function') gpuMemSetHoldRefs(v); },
            args: [on]
        });
    } catch (_) { /* no-op */ }
    // Re-scan to reflect new state.
    run();
});

// Stacks toggle: ON = capture call stack at each allocation (slow).
// Existing entries won't have stacks until they re-allocate.
$('#captureStacks').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;
        await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: 'MAIN',
            func: (v) => { if (typeof gpuMemSetCaptureStacks === 'function') gpuMemSetCaptureStacks(v); },
            args: [on]
        });
    } catch (_) { /* no-op */ }
    run();
});

// Re-scan when the user switches tabs in the same window, or when the
// active tab finishes loading a new page. Without this the panel keeps
// showing data from whichever tab was active at the last manual refresh.
chrome.tabs.onActivated.addListener(() => {
    // Drop expand/open/sort state — it's per-tab and meaningless across tabs.
    openKeys.clear(); seenKeys.clear(); stackOpenKeys.clear(); tableSort.clear();
    lastReport = null;
    run();
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'complete' && tab.active) run();
});
