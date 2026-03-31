// ─────────────────────────────────────────────
//  canvas.js
//  Single source of truth for both rendering
//  contexts and mutable dimensions.
//
//  W / H are no longer exported as plain consts —
//  use getW() / getH() wherever the value must
//  stay current across resolution changes.
//  The legacy named exports W and H are kept as
//  live getters so existing imports that read
//  them at call-time (renderer.js, hud.js) keep
//  working without changes to their import lines.
//  Code that captures W/H into a module-level
//  const at import time will see the initial
//  value only — those sites have been updated.
//
//  setResolution(w, h)
//    Resizes only the WebGL canvas and fires the
//    optional onResize callback so the GL viewport
//    and u_H uniform are updated in the same tick.
//    The HUD canvas is NOT resized here — it tracks
//    display size independently (see below).
//
//  HUD canvas — display-resolution sizing
//  ─────────────────────────────────────────────
//  _hud pixel dimensions track the physical display
//  size of #c (getBoundingClientRect × DPR), not
//  the render resolution set via setResolution().
//
//  This decouples HUD memory from the WebGL target:
//    4K render on 1080p display →
//      WebGL drawing buffer : 3840 × 1920 (VRAM)
//      HUD backing store    : ~1920 × 960 (RAM)
//    Without this fix the HUD consumed ~28 MB at 4K
//    and clearRect zeroed ~7.4 M pixels per frame.
//
//  _resizeHud() is called inside _syncHud() so
//  every layout change (window resize, fullscreen,
//  CSS reflow) keeps the pixel buffer in sync with
//  the CSS display size in a single rAF pass.
//
//  getHudW() / getHudH()
//    Return the HUD canvas pixel dimensions.
//    hud.js uses these — not getW/getH — for its
//    scale factor so the HUD stays at a consistent
//    physical size independent of render resolution.
//
//  Drawing buffer reallocation — synchronous
//  double-assign avoids intermediate allocation
//  ─────────────────────────────────────────────
//  Assigning c.width then c.height as two separate
//  statements triggers two drawing buffer
//  reallocations.  The intermediate size is
//  discarded, but leaves GPU memory fragmented on
//  most drivers — measurably degrades fill-rate
//  when switching to a higher resolution.
//
//  Fix: assign both dimensions in the same
//  synchronous block.  In Chrome this collapses to
//  a single backing-store reallocation at the final
//  size.  The same pattern is used in _resizeHud().
// ─────────────────────────────────────────────

export const c = document.querySelector('#c');
// alpha: false — makes the WebGL canvas unconditionally opaque.
//   With the default alpha:true, ANGLE (Chrome/Edge on Windows) routes
//   the canvas through the compositor's premultiplied-alpha blending
//   stage.  On some PC driver/GPU configurations this silently discards
//   drawn pixels and presents transparent-black instead.  Setting
//   alpha:false bypasses that path entirely.
//
// antialias: false — disables the implicit MSAA resolve pass that some
//   ANGLE/D3D backends insert between drawArrays and presentation.
//   That extra pass can trigger a spurious context loss when the
//   drawing buffer is reallocated during autoDetectResolution.
//
// preserveDrawingBuffer: false (default kept) — we redraw every frame
//   so we don't need the previous frame's contents to be preserved.
//   Keeping it false avoids the extra blit on mobile.
export const gl = (() => {
  const context = c.getContext('webgl2', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
  });
  if (!context) throw new Error('[canvas.js] WebGL2 is not supported in this browser.');
  return context;
})();
export const DPR = window.devicePixelRatio || 1;

// ── Render resolution (WebGL canvas) ─────────────────────────────
let _w = 800;
let _h = 400;

export function getW() { return _w; }
export function getH() { return _h; }

// Legacy named exports — kept so import { W, H } still compiles.
// These resolve at read-time via the getter, not at import-time.
// Note: only works for consumers that read W/H inside functions,
// not those that assign `const X = W` at module scope.
export { getW as W, getH as H };

// Optional callback — renderer.js installs this after init so
// setResolution can update the GL viewport and uniforms.
let _onResize = null;
export function setResizeCallback(fn) { _onResize = fn; }

c.width = _w;
c.height = _h;

// ── HUD overlay canvas ────────────────────────────────────────────
//  Pixel buffer tracks display size, not render resolution.
//  Initialised to render resolution as a fallback before the
//  first rAF fires and _syncHud() computes the real display size.
const _hud = document.createElement('canvas');
_hud.style.cssText =
  'position:fixed;pointer-events:none;' +
  'image-rendering:pixelated;image-rendering:crisp-edges;';
// Append to <html>, not <body> — body is a flex column and even a
// fixed-position child disturbs flex layout, shifting the WASD pad.
document.documentElement.appendChild(_hud);

let _hudW = _w;
let _hudH = _h;
_hud.width = _hudW;
_hud.height = _hudH;

export function getHudW() { return _hudW; }
export function getHudH() { return _hudH; }

// Resize the HUD pixel buffer to match the current CSS display size.
// Receives the already-computed BoundingClientRect from _syncHud()
// to avoid a redundant layout read.
// Guard: no-op when dimensions are unchanged — prevents spurious
// canvas clears on every rAF tick when nothing has moved.
function _resizeHud(r) {
  if (!r.width || !r.height) return;   // not yet in layout flow
  const w = Math.round(r.width * DPR);
  const h = Math.round(r.height * DPR);
  if (w === _hudW && h === _hudH) return;   // no-op guard
  _hudW = w;
  _hudH = h;
  // Synchronous double-assign — single backing-store reallocation.
  _hud.width = w;
  _hud.height = h;
}

function _syncHud() {
  const r = c.getBoundingClientRect();
  _hud.style.left = r.left + 'px';
  _hud.style.top = r.top + 'px';
  _hud.style.width = r.width + 'px';
  _hud.style.height = r.height + 'px';
  _resizeHud(r);
}

// Wrap observer and event callbacks in rAF so CSS layout has
// settled before _syncHud measures getBoundingClientRect.
const _ro = new ResizeObserver(() => requestAnimationFrame(_syncHud));
_ro.observe(c);
document.addEventListener('fullscreenchange', () => requestAnimationFrame(_syncHud));
requestAnimationFrame(_syncHud);

export const hudCtx = _hud.getContext('2d');

// ── setResolution ─────────────────────────────────────────────────
// Resizes the WebGL canvas and notifies the renderer.
// The HUD canvas is intentionally NOT resized here — its pixel
// buffer is managed entirely by _resizeHud() via layout callbacks.
//
// Guard: if the requested size equals the current size the drawing
// buffer is not touched.  Prevents accidental double-resize and
// makes repeat calls free.
export function setResolution(w, h) {
  if (w === _w && h === _h) return;   // no-op guard

  _w = w;
  _h = h;

  // Synchronous double-assign — single drawing buffer reallocation
  // at the final size, no intermediate GPU allocation.
  c.width = w;
  c.height = h;

  // Re-sync HUD CSS position after the canvas resize.
  // _resizeHud will no-op here since the display size is unchanged
  // (only the render resolution changed, not the CSS layout).
  requestAnimationFrame(_syncHud);

  // Notify renderer to update gl.viewport + u_H uniform.
  _onResize?.(w, h);
}


