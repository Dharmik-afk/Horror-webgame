// ─────────────────────────────────────────────
//  hud.js
//  HUD layer — drawn with hudCtx (the 2D overlay
//  canvas) on top of the WebGL viewport.
//
//  Exported functions
//  ─────────────────────────────────────────────
//  clearMinimap()
//    Erases the full minimap dirty region (background
//    + FOV cone overhang).  Called by drawMinimap()
//    each frame and by main.js when the minimap is
//    toggled off so no stale pixels remain.
//
//  drawMinimap(player)
//    Draws the top-down map (walls + player dot +
//    facing line + FOV cone) into the HUD canvas.
//    Only shows local player data.  Peer positions
//    are NOT yet rendered here — that is Phase 2,
//    driven by getPeers() from network.js.
//
//  drawCrosshair()
//    Draws a gap crosshair at the exact HUD centre
//    every frame.  Arm length and thickness scale
//    with getHudW() / 800 so physical size is
//    consistent at all display DPRs and resolutions.
//
//  ── Debug overlay (new) ──────────────────────────
//
//  drawDebugOverlay(player, fps, debugData)
//    Four collapsible sections in a single left-side
//    panel.  Replaces the old drawDebug + drawLookAt
//    pair.  Sections: PERFORMANCE, PLAYER, RENDERING,
//    NETWORKING.
//
//    debugData shape:
//      frameMs      — total frame rolling avg (ms)
//      gpuMs        — GPU shader rolling avg (ms)
//      renderW/H    — WebGL canvas size (pixels)
//      fov          — current FOV in degrees
//      fogDist      — current fog falloff distance
//      gpuInfo      — GPU name string
//      netConnected — boolean (from isConnected())
//      selfId       — string | null
//      peerCount    — number (getPeers().size)
//      timings      — null | verbose object
//        .rafIntervalMs  raw rAF delta rolling avg
//        .displayPeriod  vsync grid unit (ms)
//        .update         player.update avg (ms)
//        .minimap        drawMinimap avg (ms)
//        .debug          drawDebugOverlay avg (ms)
//        .castRaysFence  true = Path B gl.finish
//        .frameBudget    16.67 ms @ 60fps target
//
//  clearDebugOverlay()
//    Erases the full possible overlay region.
//    Called by main.js _clearDebugHud() whenever
//    _debugMode transitions to 0.
//
//  getDebugSections() → Map<id, bool>
//    Returns the live section collapse state map.
//    Keys: 'performance' | 'player' | 'rendering'
//          | 'networking'.
//    Value: true = collapsed, false = expanded.
//    Read by the DOM click overlay (Step 3) and
//    by Shift+1-4 hotkeys in main.js.
//
//  setDebugSectionCollapsed(id, bool)
//    Toggles a single section's collapse state.
//    Called by Shift+1-4 hotkeys in main.js and
//    by the DOM click overlay in Step 3.
//    No-op for unknown section IDs.
//
//  ── Legacy exports (still present, not called by main.js) ──
//
//  clearDebug() / clearLookAt()
//  drawDebug(player, fps, timings, renderW, renderH)
//  drawLookAt(lookAt)
//    Retained for reference and possible re-use.
//    main.js now uses drawDebugOverlay exclusively.
//
//  Scale factor
//  ─────────────────────────────────────────────
//    scale = getHudW() / 800
//
//  Uses getHudW() — the HUD canvas pixel width —
//  rather than getW() (render resolution).  These
//  are decoupled: getHudW() tracks the display
//  size of #c (getBoundingClientRect × DPR) while
//  getW() tracks the WebGL render target.
//
//  All geometry constants (MM_TILE, ix, valX, etc.)
//  are recomputed every frame so the overlay adapts
//  to display-size changes (window resize, fullscreen
//  transition) without a module reload.
//
//  Dirty-region clears
//  ─────────────────────────────────────────────
//  Each draw function clears only its own bounding
//  box to avoid zeroing unrelated HUD content.
//
//  drawMinimap clear region:
//    (MM_X − fovMargin, MM_Y − fovMargin, ...)
//    fovMargin = ceil(28 × scale) covers the FOV
//    cone lines that extend beyond the map rect.
//
//  drawDebugOverlay clear region:
//    (pad, pad, panelW, 660 × scale)
//    maxH of 660 covers all four sections fully
//    expanded with verbose timings visible.
//    The actual painted background is trimmed to
//    the real content height via destination-over
//    compositing — no second-pass trim needed.
//
//  Background rendering — destination-over
//  ─────────────────────────────────────────────
//  drawDebugOverlay paints text first, then fills
//  the background with globalCompositeOperation =
//  'destination-over'.  This places the fill behind
//  already-drawn pixels (text) and normally into
//  transparent pixels (gaps), removing the need for
//  a two-pass or pre-measure approach.
//
//  Colour coding
//  ─────────────────────────────────────────────
//  _frameColor(ms)   — overall frame / rAF time:
//    < 14 ms → green    (> ~71 fps)
//    < 20 ms → amber    (50–71 fps)
//    ≥ 20 ms → red      (< 50 fps — dropping)
//
//  _rowColor(ms, budget)  — share of 60fps budget:
//    < 25% → green    (comfortable)
//    < 50% → amber    (worth watching)
//    ≥ 50% → red      (likely culprit)
//
//  Memory sampling
//  ─────────────────────────────────────────────
//  performance.memory (Chrome-only, non-standard)
//  is sampled at ≈4 Hz via _memFrameIdx % 15.
//  The cached value is displayed between samples.
//  If the API is absent the memory row is omitted.
//
//  Collapse state
//  ─────────────────────────────────────────────
//  _sections — Map<id, bool> — owns section open/
//  closed state.  All sections start expanded.
//  State persists across F3 toggle cycles and is
//  never reset after page load.
//  Mutated by setDebugSectionCollapsed() only.
//
//  Vsync decomposition (verbose mode only)
//  ─────────────────────────────────────────────
//  vsyncBudget = round(rafMs / displayPeriod) × displayPeriod
//    Snaps the rAF interval to the nearest multiple
//    of the display refresh period measured at startup.
//
//  vsyncIdle = vsyncBudget − max(frameMs, gpuMs)
//    Headroom before the sync boundary.
//    Positive = comfortable.  Negative = missed vsync.
//
//  pipeline = rafMs − vsyncBudget
//    Chromium IPC / compositor scheduling jitter.
//    Typically ±0–3 ms.  NOT spare vsync time.
//
//  Peer / network integration (Phase 2)
//  ─────────────────────────────────────────────
//  drawMinimap() currently draws only the local
//  player.  Phase 2 will add per-peer dots by
//  calling getPeers() from network.js inside
//  drawMinimap — no API changes required here.
//  The NETWORKING section in drawDebugOverlay
//  already surfaces peer count, self ID, and a
//  ping stub ready for a Phase 2 RTT value.
// ─────────────────────────────────────────────

import { hudCtx, getHudW, getHudH } from './canvas.js';
import { WALLS, WORLD_W, WORLD_H, TEXTURES } from './map.js';

// ── Colour helpers ────────────────────────────────────────────────

// Per-component timing: share of the 60fps budget.
function _rowColor(ms, budget) {
  const r = ms / budget;
  if (r < 0.25) return '#a8e6a0';   // green — comfortable
  if (r < 0.50) return '#ffe082';   // amber — worth watching
  return '#ff6b6b';                  // red   — likely culprit
}

// Overall frame time: absolute fps thresholds.
function _frameColor(ms) {
  if (ms < 14) return '#a8e6a0';    // green — > ~71 fps
  if (ms < 20) return '#ffe082';    // amber — 50–71 fps
  return '#ff6b6b';                  // red   — < 50 fps, frames dropping
}

// Thin horizontal divider between timing groups.
function _separator(x, y, w) {
  hudCtx.save();
  hudCtx.strokeStyle = 'rgba(123, 140, 255, 0.18)';
  hudCtx.lineWidth = 1;
  hudCtx.beginPath();
  hudCtx.moveTo(x, y);
  hudCtx.lineTo(x + w, y);
  hudCtx.stroke();
  hudCtx.restore();
}

// ── clearMinimap ──────────────────────────────────────────────────
// Erases the full minimap dirty region (background + FOV cone overhang).
// Called by drawMinimap each frame and by main.js when the minimap is
// toggled off so no stale pixels remain on the HUD canvas.
export function clearMinimap() {
  const scale = getHudW() / 800;
  const MM_TILE = Math.round(10 * scale);
  const MM_PAD = Math.round(8 * scale);
  const MM_X = getHudW() - WORLD_W * MM_TILE - MM_PAD;
  const MM_Y = MM_PAD;
  const fovMargin = Math.ceil(28 * scale);
  hudCtx.clearRect(
    MM_X - fovMargin,
    MM_Y - fovMargin,
    WORLD_W * MM_TILE + fovMargin * 2,
    WORLD_H * MM_TILE + fovMargin * 2,
  );
}

// ── drawMinimap ───────────────────────────────────────────────────
// Draws the top-down minimap into the HUD canvas.
// Content: world background, wall segments, local player dot,
// facing direction line, and FOV cone (±30° from player.angle).
//
// Peer positions are NOT drawn here yet — that is Phase 2.
// When implemented, Phase 2 will call getPeers() from network.js
// and render a smaller dot per peer within this same dirty region.
export function drawMinimap(player) {
  const scale = getHudW() / 800;
  const MM_TILE = Math.round(10 * scale);
  const MM_PAD = Math.round(8 * scale);
  const MM_X = getHudW() - WORLD_W * MM_TILE - MM_PAD;
  const MM_Y = MM_PAD;

  // FOV cone lines extend up to 28*scale px beyond the minimap
  // background rect.  Clear the padded region so no ghost pixels
  // remain from the previous frame.
  const fovMargin = Math.ceil(28 * scale);
  hudCtx.clearRect(
    MM_X - fovMargin,
    MM_Y - fovMargin,
    WORLD_W * MM_TILE + fovMargin * 2,
    WORLD_H * MM_TILE + fovMargin * 2,
  );

  // ── World bounds background ─────────────────────────────────
  hudCtx.fillStyle = '#0c0c1c';
  hudCtx.fillRect(MM_X, MM_Y, WORLD_W * MM_TILE, WORLD_H * MM_TILE);

  // ── Wall segments ────────────────────────────────────────────
  hudCtx.strokeStyle = '#5868bb';
  hudCtx.lineWidth = Math.max(1, 1.5 * scale);
  for (const seg of WALLS) {
    hudCtx.beginPath();
    hudCtx.moveTo(MM_X + seg.x1 * MM_TILE, MM_Y + seg.y1 * MM_TILE);
    hudCtx.lineTo(MM_X + seg.x2 * MM_TILE, MM_Y + seg.y2 * MM_TILE);
    hudCtx.stroke();
  }

  // Player position in minimap pixel space
  const pdx = MM_X + player.pos.x * MM_TILE;
  const pdy = MM_Y + player.pos.y * MM_TILE;

  // ── FOV cone (±30° from facing angle) ───────────────────────
  hudCtx.strokeStyle = 'rgba(100, 180, 255, 0.30)';
  hudCtx.lineWidth = Math.max(1, scale);
  for (const offset of [-Math.PI / 6, Math.PI / 6]) {
    const a = player.angle + offset;
    hudCtx.beginPath();
    hudCtx.moveTo(pdx, pdy);
    hudCtx.lineTo(pdx + Math.sin(a) * 28 * scale, pdy - Math.cos(a) * 28 * scale);
    hudCtx.stroke();
  }

  // ── Facing direction line ────────────────────────────────────
  hudCtx.strokeStyle = '#ff5555';
  hudCtx.lineWidth = Math.max(1, 1.5 * scale);
  hudCtx.beginPath();
  hudCtx.moveTo(pdx, pdy);
  hudCtx.lineTo(
    pdx + Math.sin(player.angle) * 14 * scale,
    pdy - Math.cos(player.angle) * 14 * scale
  );
  hudCtx.stroke();

  // ── Player dot ───────────────────────────────────────────────
  hudCtx.fillStyle = '#ff5555';
  hudCtx.beginPath();
  hudCtx.arc(pdx, pdy, 3 * scale, 0, Math.PI * 2);
  hudCtx.fill();
}

// ── clearDebug ────────────────────────────────────────────────────
// Called by main.js when _debugVisible is toggled off.
// Erases the full possible panel region so no stale content remains.
// Full max height: baseH(104) + timH(208) + gpuH(48) = 360px @ scale 1.
export function clearDebug() {
  const scale = getHudW() / 800;
  const pad   = Math.round(8 * scale);
  const rectW = Math.round(252 * scale);
  const maxH  = Math.round(360 * scale);
  hudCtx.clearRect(pad, pad, rectW, maxH);
}

// ── drawDebug ─────────────────────────────────────────────────────
// Draws the debug info panel (always) and, when timings is non-null,
// the TIMINGS and GPU INFO sections below it.
//
// player   — read for pos, velocity, angle
// fps      — integer fps counter from main.js
// timings  — null for info-only mode; see module header for full
//             field documentation.  Passed as a plain object by
//             main.js render() when _perfVisible is true.
// renderW  — current WebGL canvas pixel width  (always passed)
// renderH  — current WebGL canvas pixel height (always passed)
//
// The full max-height region is always cleared before painting so
// toggling perf off never leaves ghost timing rows behind.
export function drawDebug(player, fps, timings, renderW, renderH) {
  const scale = getHudW() / 800;

  const pad  = Math.round(8 * scale);
  const lh   = Math.round(16 * scale);
  const x    = pad + Math.round(10 * scale);
  const rectW = Math.round(252 * scale);

  // Right-aligned value column: fixed x measured from the left of the panel.
  // All numeric values land at this x so labels and values form two clean
  // columns regardless of label length.
  const valX = pad + Math.round(238 * scale);

  // Panel height sections (baseline scale = 1):
  //   baseH  104px — DEBUG header + 5 info rows (pos, vel, ang, res, fps)
  //   timH   208px — TIMINGS: header + 5 frame rows + sep +
  //                  4 component rows + sep + 2 derived rows
  //   gpuH    48px — GPU INFO header + GPU name row
  const baseH = Math.round(104 * scale);
  const timH  = Math.round(208 * scale);
  const gpuH  = Math.round(48 * scale);
  const maxH  = baseH + timH + gpuH;
  const rectH = timings ? maxH : baseH;

  // Always clear the full max-height region first.
  // This is the key fix: if perf was on last frame (tall panel) and is now
  // off (short panel), the old rows below baseH must be erased — clearing
  // only rectH would leave ghost pixels.
  hudCtx.clearRect(pad, pad, rectW, maxH);

  // Paint the background only over the live panel height.
  hudCtx.fillStyle = 'rgba(8, 8, 20, 0.72)';
  hudCtx.fillRect(pad, pad, rectW, rectH);

  // Left accent bar — visual anchor for the panel.
  hudCtx.fillStyle = '#4af';
  hudCtx.fillRect(pad, pad, Math.round(2 * scale), rectH);

  // ── Section header helper ────────────────────────────────────
  function _sectionHeader(label, y) {
    hudCtx.fillStyle = 'rgba(68, 170, 255, 0.15)';
    hudCtx.fillRect(pad + Math.round(2 * scale), y - lh + Math.round(3 * scale),
      rectW - Math.round(2 * scale), lh);
    hudCtx.fillStyle = '#4af';
    hudCtx.font = `bold ${Math.round(10 * scale)}px Consolas, monospace`;
    hudCtx.fillText(label, x, y);
  }

  // ── Two-column row helper ────────────────────────────────────
  // Draws a dim label on the left and a coloured value right-aligned.
  function _row(label, value, y, colour) {
    hudCtx.fillStyle = 'rgba(123, 207, 255, 0.55)';
    hudCtx.font = `${Math.round(11 * scale)}px Consolas, monospace`;
    hudCtx.fillText(label, x, y);
    hudCtx.fillStyle = colour ?? '#e0e8ff';
    hudCtx.font = `bold ${Math.round(11 * scale)}px Consolas, monospace`;
    hudCtx.textAlign = 'right';
    hudCtx.fillText(value, valX, y);
    hudCtx.textAlign = 'left';
  }

  // ── DEBUG section ─────────────────────────────────────────────
  _sectionHeader('DEBUG', pad + lh);

  const angDeg = ((player.angle * 180 / Math.PI) % 360 + 360) % 360;
  _row('pos',  `${player.pos.x.toFixed(2)}, ${player.pos.y.toFixed(2)}`, pad + lh * 2 + 2);
  _row('vel',  `${player.velocity.x.toFixed(3)}, ${player.velocity.y.toFixed(3)}`, pad + lh * 3 + 2);
  _row('ang',  `${angDeg.toFixed(1)}°`, pad + lh * 4 + 2);
  _row('res',  `${renderW ?? '—'} × ${renderH ?? '—'}`, pad + lh * 5 + 2);
  _row('fps',  `${fps}`, pad + lh * 6 + 2,
    fps >= 55 ? '#a8e6a0' : fps >= 40 ? '#ffe082' : '#ff6b6b');

  if (!timings) return;

  // ── TIMINGS section ───────────────────────────────────────────
  // All values are rolling averages over RING_SIZE frames (main.js).
  const timTop   = pad + baseH;
  const sepEndX  = pad + rectW - Math.round(4 * scale);

  _sectionHeader('TIMINGS', timTop + lh);

  const frameMs       = timings.frameMs;
  const rafMs         = timings.rafIntervalMs;
  const gpuMs         = timings.castRaysGPU;
  const displayPeriod = timings.displayPeriod;  // vsync grid unit from autoDetect
  const activeMs      = Math.max(frameMs, gpuMs);
  // Snap rafMs to the nearest vsync-grid multiple for vsyncBudget.
  const n             = Math.max(1, Math.round(rafMs / displayPeriod));
  const vsyncBudget   = n * displayPeriod;
  const vsyncIdle     = vsyncBudget - activeMs;   // positive = headroom; negative = missed vsync
  const pipelineMs    = rafMs - vsyncBudget;       // IPC / compositor scheduling noise
  const predFps       = activeMs > 0 ? Math.min(999, Math.round(1000 / activeMs)) : 0;
  const measFps       = rafMs    > 0 ? Math.min(999, Math.round(1000 / rafMs))    : 0;

  _row('frame cpu',   `${frameMs.toFixed(2)} ms  ~${predFps}fps`,
    timTop + lh * 2 + 2, _frameColor(frameMs));
  _row('frame raf',   `${rafMs.toFixed(2)} ms  ~${measFps}fps`,
    timTop + lh * 3 + 2, _frameColor(rafMs));
  _row('active',      `${activeMs.toFixed(2)} ms`,
    timTop + lh * 4 + 2, _frameColor(activeMs));
  _row('vsync idle',  `${vsyncIdle.toFixed(2)} ms`,
    timTop + lh * 5 + 2, vsyncIdle < 0 ? '#ff6b6b' : '#a8e6a0');
  _row('pipeline',    `${pipelineMs.toFixed(2)} ms`,
    timTop + lh * 6 + 2, Math.abs(pipelineMs) > 4 ? '#ffe082' : '#c8c8c8');

  _separator(x, timTop + Math.round(lh * 6.7), sepEndX - x);

  const budget = timings.frameBudget;
  const fmt = ms => ms.toFixed(3) + ' ms';
  // Label reflects the timing path: async GPU query vs gl.finish fence.
  const castRaysLabel = timings.castRaysFence ? 'castRays fence' : 'castRays gpu';

  _row('player.update', fmt(timings.update),  timTop + lh * 7 + 2, _rowColor(timings.update, budget));
  _row(castRaysLabel,   fmt(gpuMs),            timTop + lh * 8 + 2, _rowColor(gpuMs, budget));
  _row('drawMinimap',   fmt(timings.minimap),  timTop + lh * 9 + 2, _rowColor(timings.minimap, budget));
  _row('drawDebug',     fmt(timings.debug),    timTop + lh * 10 + 2, _rowColor(timings.debug, budget));

  _separator(x, timTop + Math.round(lh * 10.7), sepEndX - x);

  const budgetPc = gpuMs > 0 ? (gpuMs / budget * 100) : 0;
  const fillRate = gpuMs > 0
    ? ((timings.renderW * timings.renderH) / (gpuMs * 1000)).toFixed(0)
    : '—';

  _row('gpu budget', `${budgetPc.toFixed(1)} %`,    timTop + lh * 11 + 2, '#ffe082');
  _row('fill rate',  `${fillRate} Mfrag/s`,          timTop + lh * 12 + 2, '#ffe082');

  // ── GPU INFO section ──────────────────────────────────────────
  const gpuTop = timTop + timH;

  _sectionHeader('GPU', gpuTop + lh);

  hudCtx.fillStyle = '#c8b8ff';
  hudCtx.font = `${Math.round(10 * scale)}px Consolas, monospace`;
  hudCtx.fillText(timings.gpuInfo, x, gpuTop + lh * 2 + 2);
}

// ── drawCrosshair ─────────────────────────────────────────────────
// Draws a simple + crosshair at the exact centre of the HUD canvas.
// Thickness and arm length scale with the HUD pixel width so the
// crosshair stays a consistent physical size at all display DPRs and
// render resolutions (HUD tracks display size, not render resolution).
//
// Gap: a small empty square at the centre keeps the crosshair open
// and avoids obscuring whatever is directly under the cursor.
//
// Called every frame from main.js render() after castRays() and
// before drawMinimap(), so it sits above the 3D scene but below
// any minimap or debug overlay content.
export function drawCrosshair() {
  const scale = getHudW() / 800;
  const cx    = getHudW() / 2;
  const cy    = getHudH() / 2;

  // Geometry — all values in HUD pixels.
  const arm       = Math.round(10 * scale);   // length of each arm
  const thickness = Math.max(1, Math.round(2 * scale));
  const gap       = Math.round(3 * scale);    // empty centre gap

  const half = thickness / 2;

  hudCtx.save();
  hudCtx.fillStyle = 'rgba(255, 255, 255, 0.85)';

  // Horizontal left arm
  hudCtx.fillRect(cx - gap - arm, cy - half, arm, thickness);
  // Horizontal right arm
  hudCtx.fillRect(cx + gap,       cy - half, arm, thickness);
  // Vertical top arm
  hudCtx.fillRect(cx - half, cy - gap - arm, thickness, arm);
  // Vertical bottom arm
  hudCtx.fillRect(cx - half, cy + gap,       thickness, arm);

  hudCtx.restore();
}

// ── Look-at panel helpers ─────────────────────────────────────────
//
//  The look-at panel is positioned directly below the minimap so the
//  two share the same left edge and width.  All measurements are
//  derived from the same scale factor and minimap constants used by
//  drawMinimap() so they stay aligned across HUD sizes.
//
//  Panel structure (all heights at baseline scale = 1):
//    header row          : 20px  — "LOOK AT" accent bar
//    seg / room row      : 16px
//    separator           : 10px
//    GEOMETRY section    : 16px label + 5 × 16px rows = 96px
//    separator           : 10px
//    MATERIAL section    : 16px label + 3–5 × 16px rows
//    separator           : 10px
//    normal row          : 16px
//
//  Maximum height ≈ 240px at scale = 1.  At a 2:1 canvas aspect and
//  800px HUD width the canvas is 400px tall, so the panel fits below
//  the 124px minimap bottom with room to spare.

// Returns { x, y, w, maxH } — the bounding box of the look-at panel.
// Both clearLookAt() and drawLookAt() call this so the region is
// always consistent.
function _lookAtBounds() {
  const scale   = getHudW() / 800;
  const MM_TILE = Math.round(10 * scale);
  const MM_PAD  = Math.round(8  * scale);
  const fovMgn  = Math.ceil(28  * scale);

  const w = WORLD_W * MM_TILE;                            // same as minimap width
  const x = getHudW() - w - MM_PAD;                       // same left edge as minimap
  const y = MM_PAD + WORLD_H * MM_TILE + fovMgn + MM_PAD; // gap below minimap bottom
  const maxH = Math.round(240 * scale);                   // conservative worst-case height

  return { x, y, w, maxH };
}

// ── clearLookAt ───────────────────────────────────────────────────
// Erases the full look-at panel dirty region.
// Called by main.js when the debug overlay is toggled off so no stale
// content remains on the HUD canvas.
export function clearLookAt() {
  const { x, y, w, maxH } = _lookAtBounds();
  hudCtx.clearRect(x, y, w, maxH);
}

// ── drawLookAt(lookAt) ────────────────────────────────────────────
// Draws the look-at info panel below the minimap.
//
// lookAt — null (no hit) or the object returned by castCenterRay():
//   { segIndex, dist, u, seg }
//
// Segment object fields displayed:
//   segIndex, seg.roomId
//   seg.x1, seg.y1, seg.x2, seg.y2  (geometry)
//   derived length from seg.ex/ey
//   dist (ray distance), u (parametric hit position)
//   seg.texId / seg.r,g,b / seg.brightness  (material)
//   seg.absNY  (lighting normal)
export function drawLookAt(lookAt) {
  const scale = getHudW() / 800;
  const { x: px, y: py, w: panelW, maxH } = _lookAtBounds();

  const lh    = Math.round(16 * scale);
  const smLh  = Math.round(13 * scale);   // small font line height
  const ix    = px + Math.round(8  * scale);   // text left margin inside panel
  const valX  = px + panelW - Math.round(6 * scale);  // right-align values here

  // Always clear the full possible region before painting.
  hudCtx.clearRect(px, py, panelW, maxH);

  // ── Panel background ─────────────────────────────────────────────
  hudCtx.fillStyle = 'rgba(8, 8, 20, 0.72)';
  hudCtx.fillRect(px, py, panelW, maxH);

  // Left accent bar — matches debug panel style.
  hudCtx.fillStyle = '#fa0';   // amber — distinct from debug panel's cyan
  hudCtx.fillRect(px, py, Math.round(2 * scale), maxH);

  // ── Local row helper ─────────────────────────────────────────────
  // label at ix, value right-aligned at valX.
  function row(label, value, y, colour) {
    hudCtx.fillStyle = 'rgba(200, 175, 100, 0.55)';
    hudCtx.font = `${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText(label, ix, y);
    hudCtx.fillStyle = colour ?? '#e0e8ff';
    hudCtx.font = `bold ${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'right';
    hudCtx.fillText(value, valX, y);
    hudCtx.textAlign = 'left';
  }

  function sectionHeader(label, y) {
    hudCtx.fillStyle = 'rgba(255, 170, 0, 0.12)';
    hudCtx.fillRect(px + Math.round(2 * scale), y - lh + Math.round(3 * scale),
      panelW - Math.round(2 * scale), lh);
    hudCtx.fillStyle = '#fa0';
    hudCtx.font = `bold ${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText(label, ix, y);
  }

  function sep(y) {
    hudCtx.save();
    hudCtx.strokeStyle = 'rgba(255, 170, 0, 0.15)';
    hudCtx.lineWidth = 1;
    hudCtx.beginPath();
    hudCtx.moveTo(ix, y);
    hudCtx.lineTo(px + panelW - Math.round(4 * scale), y);
    hudCtx.stroke();
    hudCtx.restore();
  }

  let cy = py + lh;

  sectionHeader('LOOK AT', cy);
  cy += Math.round(4 * scale);

  // ── No hit ───────────────────────────────────────────────────────
  if (!lookAt) {
    cy += lh;
    hudCtx.fillStyle = 'rgba(200, 175, 100, 0.55)';
    hudCtx.font = `${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText('no hit', ix, cy);
    // shrink background to actual content height
    hudCtx.clearRect(px, py + (cy - py) + lh, panelW, maxH - (cy - py) - lh);
    hudCtx.fillStyle = 'rgba(8, 8, 20, 0.72)';
    hudCtx.fillRect(px, py, panelW, (cy - py) + lh + Math.round(6 * scale));
    return;
  }

  const { segIndex, dist, u, seg } = lookAt;

  // ── Identity ─────────────────────────────────────────────────────
  cy += lh;
  row('seg',  `#${segIndex}`,       cy);
  cy += lh;
  row('room', seg.roomId ?? '—',    cy);

  cy += Math.round(8 * scale);
  sep(cy);
  cy += Math.round(10 * scale);

  // ── Geometry ─────────────────────────────────────────────────────
  sectionHeader('GEOMETRY', cy);
  cy += lh;

  row('x1, y1',
    `${seg.x1.toFixed(2)}, ${seg.y1.toFixed(2)}`, cy);
  cy += lh;
  row('x2, y2',
    `${seg.x2.toFixed(2)}, ${seg.y2.toFixed(2)}`, cy);
  cy += lh;

  const segLen = Math.hypot(seg.ex, seg.y2 - seg.y1);   // recompute from ex/ey
  const trueLen = Math.hypot(seg.ex, seg.ey);
  row('length', `${trueLen.toFixed(3)} t`, cy);
  cy += lh;
  row('dist',   `${dist.toFixed(3)} t`,   cy,
    dist < 3 ? '#a8e6a0' : dist < 8 ? '#ffe082' : '#ff6b6b');
  cy += lh;

  const uPct = (u * 100).toFixed(1);
  row('hit u', `${u.toFixed(3)}  (${uPct}%)`, cy);

  cy += Math.round(8 * scale);
  sep(cy);
  cy += Math.round(10 * scale);

  // ── Material ─────────────────────────────────────────────────────
  sectionHeader('MATERIAL', cy);
  cy += lh;

  const isTextured = seg.texId >= 0;

  if (isTextured) {
    row('type', 'texture', cy, '#c8b8ff');
    cy += lh;
    row('tex id', `${seg.texId}`, cy, '#c8b8ff');
    cy += lh;

    // Basename of the texture path — strip leading directories.
    const fullPath = TEXTURES[seg.texId] ?? '?';
    const basename = fullPath.split('/').pop();
    // Truncate if too long to fit (panel is ~160px wide at scale 1).
    const maxChars = Math.floor(panelW / (smLh * 0.6));
    const display  = basename.length > maxChars
      ? basename.slice(0, maxChars - 1) + '…'
      : basename;
    row('file', display, cy, '#c8b8ff');
    cy += lh;

    // brightness stored as normalised [−1,1]; display as original [−50,50]
    const brightRaw = Math.round(seg.brightness * 50);
    const brightStr = brightRaw >= 0 ? `+${brightRaw}` : `${brightRaw}`;
    row('bright', brightStr, cy,
      brightRaw > 0 ? '#a8e6a0' : brightRaw < 0 ? '#ff6b6b' : '#e0e8ff');
    cy += lh;
  } else {
    row('type', 'color', cy, '#ffb8b8');
    cy += lh;
    const hexR = seg.r.toString(16).padStart(2, '0');
    const hexG = seg.g.toString(16).padStart(2, '0');
    const hexB = seg.b.toString(16).padStart(2, '0');
    row('hex',   `#${hexR}${hexG}${hexB}`.toUpperCase(), cy, '#ffb8b8');
    cy += lh;
    row('r/g/b', `${seg.r}, ${seg.g}, ${seg.b}`,          cy, '#ffb8b8');
    cy += lh;
  }

  cy += Math.round(8 * scale);
  sep(cy);
  cy += Math.round(10 * scale);

  // ── Lighting ─────────────────────────────────────────────────────
  sectionHeader('LIGHTING', cy);
  cy += lh;
  row('|normal y|', seg.absNY.toFixed(4), cy, '#ffe082');

  // Shrink background to actual drawn height + small bottom padding.
  const actualH = (cy - py) + Math.round(10 * scale);
  hudCtx.clearRect(px, py + actualH, panelW, maxH - actualH);
  // Repaint background tightly over the real content area only.
  hudCtx.fillStyle = 'rgba(8, 8, 20, 0.72)';
  hudCtx.fillRect(px, py, panelW, actualH);
  // Re-draw accent bar at the correct height.
  hudCtx.fillStyle = '#fa0';
  hudCtx.fillRect(px, py, Math.round(2 * scale), actualH);
}

// ═════════════════════════════════════════════════════════════════
//  NEW DEBUG OVERLAY  (replaces drawDebug + drawLookAt in main.js)
// ═════════════════════════════════════════════════════════════════
//
//  Four collapsible sections — PERFORMANCE, PLAYER, RENDERING,
//  NETWORKING — drawn in a single left-side panel.
//
//  Collapse state is owned by _sections (Map<id, bool>).
//  It persists across F3 toggles and is never reset after init.
//
//  Background rendering uses globalCompositeOperation:'destination-over'
//  so the background is painted BEHIND already-drawn text in a single
//  pass — no two-pass or trim-then-repaint logic needed.
//
//  Memory read is throttled to ≈4 Hz via a module-level frame counter
//  so performance.memory is never sampled more than necessary.
//
//  debugData fields expected by drawDebugOverlay:
//    frameMs      — total frame rolling avg ms
//    gpuMs        — GPU shader rolling avg ms
//    renderW/H    — current WebGL canvas size (pixels)
//    fov          — current FOV in degrees (from getFov())
//    fogDist      — current fog distance (from getFogDist())
//    gpuInfo      — GPU name string (from getGPUInfo())
//    netConnected — boolean (from isConnected())
//    selfId       — string | null (from getSelfId())
//    peerCount    — number (getPeers().size)
//    timings      — null | verbose object (only when _debugMode >= 2)
//      .rafIntervalMs, .displayPeriod, .update, .minimap, .debug,
//      .castRaysFence, .frameBudget
// ─────────────────────────────────────────────────────────────────

// ── Section collapse state ────────────────────────────────────────
// Map<id, bool>  true = collapsed, false = expanded.
// All start expanded.  Never reset after page load.
const _sections = new Map([
  ['performance', false],   // expanded by default — primary section
  ['player',      true ],   // collapsed by default — expand on demand
  ['rendering',   true ],   // collapsed by default — expand on demand
  ['networking',  true ],   // collapsed by default — expand on demand
]);

// Returns the live Map so the DOM click-overlay (Step 3) can read it.
export function getDebugSections() { return _sections; }

// Called by Shift+1-4 hotkeys in main.js and the DOM overlay in Step 3.
export function setDebugSectionCollapsed(id, collapsed) {
  if (_sections.has(id)) _sections.set(id, !!collapsed);
}

// ── Memory read throttle ──────────────────────────────────────────
// performance.memory is non-standard (Chrome only) and relatively
// expensive to query.  Cache the result and refresh at ≈4 Hz.
let _memFrameIdx  = 0;
let _memCachedMB  = null;

function _readMemoryMB() {
  _memFrameIdx++;
  if (_memFrameIdx % 15 === 1) {
    const m = performance.memory;
    _memCachedMB = m ? Math.round(m.usedJSHeapSize / (1024 * 1024)) : null;
  }
  return _memCachedMB;
}

// ── clearDebugOverlay ─────────────────────────────────────────────
// Erases both the left debug panel and the right segment panel.
// Called by main.js _clearDebugHud() whenever debug is toggled off.
export function clearDebugOverlay() {
  const scale  = getHudW() / 800;
  const pad    = Math.round(8 * scale);
  const panelW = Math.round(252 * scale);
  // Left panel
  hudCtx.clearRect(pad, pad, panelW, Math.round(660 * scale));
  // Right segment panel — same width, anchored to right edge like minimap
  const MM_TILE = Math.round(10 * scale);
  const MM_PAD  = Math.round(8  * scale);
  const rpW     = WORLD_W * MM_TILE;
  const rpX     = getHudW() - rpW - MM_PAD;
  const fovMgn  = Math.ceil(28 * scale);
  const rpY     = MM_PAD + WORLD_H * MM_TILE + fovMgn + MM_PAD;
  hudCtx.clearRect(rpX, rpY, rpW, Math.round(300 * scale));
}

// ── drawDebugOverlay(player, fps, debugData, lookAt) ──────────────
//
// Left panel  — four collapsible sections: PERFORMANCE, PLAYER,
//               RENDERING, NETWORKING.
// Right panel — segment info (LOOK AT) below the minimap, same
//               position as the old drawLookAt().
//
// Height guard: if the left panel would overflow the HUD canvas,
// remaining sections are auto-collapsed for this frame only.
// Shift+1–4 hotkeys toggle collapse state permanently.
export function drawDebugOverlay(player, fps, debugData, lookAt) {
  hudCtx.save();   // ── isolate all canvas state changes ──────────────

  const scale  = getHudW() / 800;
  const hudH   = getHudH();
  const pad    = Math.round(8  * scale);
  const lh     = Math.round(18 * scale);
  const rowH   = Math.round(16 * scale);
  const smLh   = Math.round(11 * scale);
  const hdrLh  = Math.round(10 * scale);
  const panelW = Math.round(252 * scale);
  const ix     = pad + Math.round(12 * scale);
  const valX   = pad + panelW - Math.round(8 * scale);
  const maxH   = Math.round(660 * scale);

  // Clear full possible region before drawing.
  hudCtx.clearRect(pad, pad, panelW, maxH);

  // ── Row helper ────────────────────────────────────────────────────
  function row(label, value, y, colour) {
    hudCtx.fillStyle = 'rgba(123, 207, 255, 0.55)';
    hudCtx.font      = `${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText(label, ix, y);
    hudCtx.fillStyle = colour ?? '#e0e8ff';
    hudCtx.font      = `bold ${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'right';
    hudCtx.fillText(value, valX, y);
    hudCtx.textAlign = 'left';
  }

  // ── Section header ────────────────────────────────────────────────
  function sectionHeader(id, title, y) {
    const collapsed = _sections.get(id);
    hudCtx.save();
    hudCtx.globalCompositeOperation = 'destination-over';
    hudCtx.fillStyle = 'rgba(68, 170, 255, 0.09)';
    hudCtx.fillRect(pad + Math.round(2 * scale),
      y - lh + Math.round(3 * scale),
      panelW - Math.round(2 * scale), lh);
    hudCtx.restore();
    hudCtx.fillStyle = '#4af';
    hudCtx.font      = `bold ${hdrLh}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText(collapsed ? '▶' : '▼', ix, y);
    hudCtx.fillText(title, ix + Math.round(14 * scale), y);
  }

  function innerSep(y) {
    hudCtx.save();
    hudCtx.strokeStyle = 'rgba(68, 170, 255, 0.12)';
    hudCtx.lineWidth   = 1;
    hudCtx.beginPath();
    hudCtx.moveTo(ix, y);
    hudCtx.lineTo(pad + panelW - Math.round(4 * scale), y);
    hudCtx.stroke();
    hudCtx.restore();
  }

  function sectionSep(y) {
    hudCtx.save();
    hudCtx.strokeStyle = 'rgba(68, 170, 255, 0.22)';
    hudCtx.lineWidth   = 1;
    hudCtx.beginPath();
    hudCtx.moveTo(pad + Math.round(2 * scale), y);
    hudCtx.lineTo(pad + panelW - Math.round(4 * scale), y);
    hudCtx.stroke();
    hudCtx.restore();
  }

  // ── Height guard ──────────────────────────────────────────────────
  const safeBottom = hudH - pad;
  function wouldOverflow(cy) { return cy > safeBottom; }

  let cy = pad + lh;

  // ══════════════════════════════════════════════════════════════════
  // PERFORMANCE
  // ══════════════════════════════════════════════════════════════════
  sectionHeader('performance', 'PERFORMANCE', cy);
  cy += Math.round(4 * scale);

  const perfCollapsed = _sections.get('performance') || wouldOverflow(cy + rowH * 3);
  if (!perfCollapsed) {
    // ── Core frame metrics ───────────────────────────────────────────
    cy += rowH;
    row('fps',   `${fps}`, cy,
      fps >= 55 ? '#a8e6a0' : fps >= 40 ? '#ffe082' : '#ff6b6b');
    cy += rowH;
    row('frame', `${debugData.frameMs.toFixed(2)} ms`, cy,
      _frameColor(debugData.frameMs));
    cy += rowH;
    row('gpu',   `${debugData.gpuMs.toFixed(2)} ms`, cy,
      _rowColor(debugData.gpuMs, 1000 / 60));

    const memMB = _readMemoryMB();
    if (memMB !== null) {
      cy += rowH;
      row('memory', `${memMB} MB`, cy,
        memMB < 512 ? '#a8e6a0' : memMB < 1024 ? '#ffe082' : '#ff6b6b');
    }

    // ── Verbose block — mode 2 only ──────────────────────────────────
    if (debugData.timings && !wouldOverflow(cy + rowH * 8 + Math.round(12 * scale))) {
      const t       = debugData.timings;
      const rafMs   = debugData.rafMs;
      const active  = Math.max(debugData.frameMs, debugData.gpuMs);
      const n       = Math.max(1, Math.round(rafMs / debugData.displayPeriod));
      const vBudget = n * debugData.displayPeriod;
      const vIdle   = vBudget - active;
      const pipeline = rafMs - vBudget;

      cy += Math.round(5 * scale); innerSep(cy); cy += Math.round(7 * scale);
      row('raf',        `${rafMs.toFixed(2)} ms`,    cy, _frameColor(rafMs));
      cy += rowH;
      row('vsync idle', `${vIdle.toFixed(2)} ms`,    cy,
        vIdle < 0 ? '#ff6b6b' : '#a8e6a0');
      cy += rowH;
      row('pipeline',   `${pipeline.toFixed(2)} ms`, cy,
        Math.abs(pipeline) > 4 ? '#ffe082' : '#c8c8c8');

      cy += Math.round(5 * scale); innerSep(cy); cy += Math.round(7 * scale);
      row('update',  `${t.update.toFixed(3)} ms`,  cy, _rowColor(t.update, t.frameBudget));
      cy += rowH;
      row(t.castRaysFence ? 'rays fence' : 'rays gpu',
        `${debugData.gpuMs.toFixed(3)} ms`,         cy, _rowColor(debugData.gpuMs, t.frameBudget));
      cy += rowH;
      row('minimap', `${t.minimap.toFixed(3)} ms`,  cy, _rowColor(t.minimap, t.frameBudget));
      cy += rowH;
      row('hud',     `${t.debug.toFixed(3)} ms`,    cy, _rowColor(t.debug, t.frameBudget));
      cy += rowH;
      const gpuPc = debugData.gpuMs > 0
        ? (debugData.gpuMs / t.frameBudget * 100).toFixed(1) : '0.0';
      row('gpu %', `${gpuPc}%`, cy, '#ffe082');
      cy += rowH;
      const fillRate = debugData.gpuMs > 0
        ? ((debugData.renderW * debugData.renderH) / (debugData.gpuMs * 1000)).toFixed(0)
        : '—';
      row('fill rate', `${fillRate} Mfrag/s`, cy, '#ffe082');
    }
  }

  cy += Math.round(8 * scale); sectionSep(cy); cy += Math.round(8 * scale);

  // ══════════════════════════════════════════════════════════════════
  // PLAYER
  // ══════════════════════════════════════════════════════════════════
  sectionHeader('player', 'PLAYER', cy);
  cy += Math.round(4 * scale);

  const playerCollapsed = _sections.get('player') || wouldOverflow(cy + rowH * 4);
  if (!playerCollapsed) {
    // ── Core state ───────────────────────────────────────────────────
    cy += rowH;
    row('pos',   `${player.pos.x.toFixed(2)}, ${player.pos.y.toFixed(2)}`, cy);
    cy += rowH;
    row('vel',   `${player.velocity.x.toFixed(3)}, ${player.velocity.y.toFixed(3)}`, cy);
    cy += rowH;
    const angDeg = ((player.angle * 180 / Math.PI) % 360 + 360) % 360;
    row('angle', `${angDeg.toFixed(1)}°`, cy);
    cy += rowH;

    // Input keys — per-letter colour.
    const inp     = player.input;
    const kActive = [inp.y < 0, inp.x < 0, inp.y > 0, inp.x > 0];
    hudCtx.fillStyle = 'rgba(123, 207, 255, 0.55)';
    hudCtx.font      = `${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText('input', ix, cy);
    const kBase = valX - Math.round(54 * scale);
    const kStep = Math.round(14 * scale);
    hudCtx.font = `bold ${smLh}px Consolas, monospace`;
    ['W', 'A', 'S', 'D'].forEach((k, i) => {
      hudCtx.fillStyle = kActive[i] ? '#a8e6a0' : 'rgba(200, 210, 255, 0.22)';
      hudCtx.textAlign = 'left';
      hudCtx.fillText(k, kBase + i * kStep, cy);
    });

    // ── Extended physics info ─────────────────────────────────────────
    cy += Math.round(5 * scale); innerSep(cy); cy += Math.round(7 * scale);
    row('facing',
      `${player.sinA.toFixed(3)}, ${(-player.cosA).toFixed(3)}`, cy,
      'rgba(200, 210, 255, 0.70)');
    cy += rowH;
    const speed = Math.hypot(player.velocity.x, player.velocity.y);
    row('speed',  `${speed.toFixed(4)} t/f`, cy,
      speed > 0.15 ? '#ffe082' : '#e0e8ff');
    cy += rowH;
    row('radius', `${player.radius.toFixed(2)} t`, cy, '#e0e8ff');
  }

  cy += Math.round(8 * scale); sectionSep(cy); cy += Math.round(8 * scale);

  // ══════════════════════════════════════════════════════════════════
  // RENDERING
  // ══════════════════════════════════════════════════════════════════
  sectionHeader('rendering', 'RENDERING', cy);
  cy += Math.round(4 * scale);

  const renderCollapsed = _sections.get('rendering') || wouldOverflow(cy + rowH * 4);
  if (!renderCollapsed) {
    // ── Core display info ─────────────────────────────────────────────
    cy += rowH;
    row('res', `${debugData.renderW} × ${debugData.renderH}`, cy);
    cy += rowH;
    row('fov', `${debugData.fov}°`, cy);
    cy += rowH;
    row('fog dist', `${debugData.fogDist}`, cy);
    cy += rowH;
    const gpuRaw = debugData.gpuInfo ?? 'unknown';
    const maxCh  = Math.max(8, Math.floor((panelW - Math.round(50 * scale)) / (smLh * 0.62)));
    const gpuStr = gpuRaw.length > maxCh ? gpuRaw.slice(0, maxCh - 1) + '…' : gpuRaw;
    row('gpu', gpuStr, cy, '#c8b8ff');

    // ── World / shader stats ──────────────────────────────────────────
    cy += Math.round(5 * scale); innerSep(cy); cy += Math.round(7 * scale);
    row('segments',
      `${debugData.wallsCount} / ${debugData.maxSegments}`, cy,
      debugData.wallsCount > debugData.maxSegments * 0.8 ? '#ff6b6b' : '#e0e8ff');
    cy += rowH;
    row('tex layers', `${debugData.textureCount}`, cy, '#e0e8ff');
    cy += rowH;
    row('world',
      `${debugData.worldW} × ${debugData.worldH} t`, cy, '#e0e8ff');
    cy += rowH;
    row('fog amt', '85%', cy, '#e0e8ff');
  }

  cy += Math.round(8 * scale); sectionSep(cy); cy += Math.round(8 * scale);

  // ══════════════════════════════════════════════════════════════════
  // NETWORKING
  // ══════════════════════════════════════════════════════════════════
  sectionHeader('networking', 'NETWORKING', cy);
  cy += Math.round(4 * scale);

  const netCollapsed = _sections.get('networking') || wouldOverflow(cy + rowH * 4);
  if (!netCollapsed) {
    cy += rowH;
    row('status',
      debugData.netConnected ? 'connected' : 'offline', cy,
      debugData.netConnected ? '#a8e6a0' : '#ff6b6b');
    cy += rowH;
    const sid   = debugData.selfId;
    const idStr = sid ? (sid.length > 9 ? sid.slice(0, 8) + '…' : sid) : '—';
    row('self id', idStr, cy);
    cy += rowH;
    row('peers', `${debugData.peerCount}`, cy);
    cy += rowH;
    row('ping', '—', cy, 'rgba(200, 210, 255, 0.35)');
  }

  // ── Hotkey hint ───────────────────────────────────────────────────
  cy += Math.round(10 * scale);
  if (!wouldOverflow(cy + Math.round(12 * scale))) {
    hudCtx.fillStyle = 'rgba(100, 140, 200, 0.30)';
    hudCtx.font      = `${Math.round(9 * scale)}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText('Shift+1–4 toggle  ·  F3 cycle', ix, cy);
  }

  cy += Math.round(12 * scale);
  const actualH = cy - pad;

  // ── Background (destination-over — paints behind text) ────────────
  hudCtx.save();
  hudCtx.globalCompositeOperation = 'destination-over';
  hudCtx.fillStyle = 'rgba(8, 8, 20, 0.82)';
  hudCtx.fillRect(pad, pad, panelW, actualH);
  hudCtx.restore();

  // Accent bar on top.
  hudCtx.fillStyle = '#4af';
  hudCtx.fillRect(pad, pad, Math.round(2 * scale), actualH);

  // ── Right panel ───────────────────────────────────────────────────
  _drawSegmentPanel(lookAt, scale);

  hudCtx.restore();   // ── restore all canvas state ──────────────────
}

// ── _drawSegmentPanel(lookAt, scale) ─────────────────────────────
// Internal. Draws the LOOK AT segment info panel on the right side,
// anchored below the minimap exactly as the old drawLookAt() was.
// lookAt is null (no hit) or { segIndex, dist, u, seg }.
function _drawSegmentPanel(lookAt, scale) {
  hudCtx.save();   // isolate canvas state
  const MM_TILE = Math.round(10 * scale);
  const MM_PAD  = Math.round(8  * scale);
  const fovMgn  = Math.ceil(28  * scale);

  const panelW  = WORLD_W * MM_TILE;
  const px      = getHudW() - panelW - MM_PAD;
  const py      = MM_PAD + WORLD_H * MM_TILE + fovMgn + MM_PAD;
  const maxH    = Math.round(300 * scale);

  const lh      = Math.round(16 * scale);
  const smLh    = Math.round(11 * scale);
  const ix      = px + Math.round(8 * scale);
  const valX    = px + panelW - Math.round(6 * scale);

  hudCtx.clearRect(px, py, panelW, maxH);

  function row(label, value, y, colour) {
    hudCtx.fillStyle = 'rgba(200, 175, 100, 0.55)';
    hudCtx.font      = `${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText(label, ix, y);
    hudCtx.fillStyle = colour ?? '#e0e8ff';
    hudCtx.font      = `bold ${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'right';
    hudCtx.fillText(value, valX, y);
    hudCtx.textAlign = 'left';
  }

  function hdr(label, y) {
    hudCtx.save();
    hudCtx.globalCompositeOperation = 'destination-over';
    hudCtx.fillStyle = 'rgba(255, 170, 0, 0.10)';
    hudCtx.fillRect(px + Math.round(2 * scale), y - lh + Math.round(3 * scale),
      panelW - Math.round(2 * scale), lh);
    hudCtx.restore();
    hudCtx.fillStyle = '#fa0';
    hudCtx.font      = `bold ${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText(label, ix, y);
  }

  function sep(y) {
    hudCtx.save();
    hudCtx.strokeStyle = 'rgba(255, 170, 0, 0.15)';
    hudCtx.lineWidth   = 1;
    hudCtx.beginPath();
    hudCtx.moveTo(ix, y);
    hudCtx.lineTo(px + panelW - Math.round(4 * scale), y);
    hudCtx.stroke();
    hudCtx.restore();
  }

  let cy = py + lh;
  hdr('LOOK AT', cy);
  cy += Math.round(4 * scale);

  if (!lookAt) {
    cy += lh;
    hudCtx.fillStyle = 'rgba(200, 175, 100, 0.45)';
    hudCtx.font      = `${smLh}px Consolas, monospace`;
    hudCtx.textAlign = 'left';
    hudCtx.fillText('no hit', ix, cy);
    cy += Math.round(8 * scale);
  } else {
    const { segIndex, dist, u, seg } = lookAt;

    cy += lh; row('seg',    `#${segIndex}`,                   cy);
    cy += lh; row('room',   seg.roomId ?? '—',                cy);

    cy += Math.round(6 * scale); sep(cy); cy += Math.round(8 * scale);
    hdr('GEOMETRY', cy);
    cy += lh; row('x1, y1', `${seg.x1.toFixed(2)}, ${seg.y1.toFixed(2)}`, cy);
    cy += lh; row('x2, y2', `${seg.x2.toFixed(2)}, ${seg.y2.toFixed(2)}`, cy);
    cy += lh; row('length', `${Math.hypot(seg.ex, seg.ey).toFixed(3)} t`,  cy);
    cy += lh; row('dist',   `${dist.toFixed(3)} t`, cy,
      dist < 3 ? '#a8e6a0' : dist < 8 ? '#ffe082' : '#ff6b6b');
    cy += lh; row('hit u',  `${u.toFixed(3)} (${(u * 100).toFixed(1)}%)`,  cy);

    cy += Math.round(6 * scale); sep(cy); cy += Math.round(8 * scale);
    hdr('MATERIAL', cy);
    const isTextured = seg.texId >= 0;
    if (isTextured) {
      cy += lh; row('type',    'texture',        cy, '#c8b8ff');
      cy += lh; row('tex id',  `${seg.texId}`,   cy, '#c8b8ff');
      const fullPath = TEXTURES[seg.texId] ?? '?';
      const basename = fullPath.split('/').pop();
      const maxCh    = Math.max(6, Math.floor(panelW / (smLh * 0.65)));
      const display  = basename.length > maxCh ? basename.slice(0, maxCh - 1) + '…' : basename;
      cy += lh; row('file', display, cy, '#c8b8ff');
      const brightRaw = Math.round(seg.brightness * 50);
      cy += lh; row('bright', brightRaw >= 0 ? `+${brightRaw}` : `${brightRaw}`, cy,
        brightRaw > 0 ? '#a8e6a0' : brightRaw < 0 ? '#ff6b6b' : '#e0e8ff');
    } else {
      cy += lh; row('type', 'color', cy, '#ffb8b8');
      const hexR = seg.r.toString(16).padStart(2, '0');
      const hexG = seg.g.toString(16).padStart(2, '0');
      const hexB = seg.b.toString(16).padStart(2, '0');
      cy += lh; row('hex',   `#${hexR}${hexG}${hexB}`.toUpperCase(), cy, '#ffb8b8');
      cy += lh; row('r/g/b', `${seg.r}, ${seg.g}, ${seg.b}`,          cy, '#ffb8b8');
    }

    cy += Math.round(6 * scale); sep(cy); cy += Math.round(8 * scale);
    hdr('LIGHTING', cy);
    cy += lh; row('|normal y|', seg.absNY.toFixed(4), cy, '#ffe082');
  }

  const actualH = (cy - py) + Math.round(10 * scale);

  hudCtx.save();
  hudCtx.globalCompositeOperation = 'destination-over';
  hudCtx.fillStyle = 'rgba(8, 8, 20, 0.82)';
  hudCtx.fillRect(px, py, panelW, actualH);
  hudCtx.restore();

  hudCtx.fillStyle = '#fa0';
  hudCtx.fillRect(px, py, Math.round(2 * scale), actualH);

  hudCtx.restore();   // restore canvas state
}

