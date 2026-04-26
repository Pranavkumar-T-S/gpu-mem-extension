# GPU Memory Profiler — Chrome Extension

Hooks `getContext` at `document_start` in the page's MAIN world. Works on any
WebGL/WebGL2 app

## Install

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select this folder: `gpu-mem-extension/`

## Use

1. Open the target page (Figma, vanihq, your app, etc.). **Reload after install.**
2. Use the app for a bit so it allocates GPU resources.
3. Open DevTools console and run `gpuMemReport()` / `gpuMemReport({verbose:true, perContext:true})`.

## Notes

- `world: "MAIN"` in the content_scripts entry runs the script in the page's
  JS realm, so `HTMLCanvasElement.prototype.getContext` patching actually
  affects the app's contexts.
- `match_origin_as_fallback: true` ensures workers' OffscreenCanvas creations
  are also covered when possible.
- For pages that already had a context before install/enable, call
  `installGpuMemHooks(gl)` manually on the live `gl`.
