// ─────────────────────────────────────────────
//  renderer.js
//  WebGL2 GPU raycaster.  All 3D view rendering
//  is performed by a single fragment shader draw
//  call — no CPU pixel or column loops.
//
// ─────────────────────────────────────────────
//  Exported API
// ─────────────────────────────────────────────
//
//  initRenderer()
//    Called once at startup after loadLevel().
//    Compiles and links shaders, builds the segment
//    RGBA32F texture, caches all uniform locations,
//    uploads permanent uniforms (u_H, u_segmentCount,
//    u_segments, u_texAtlas), creates a 1×1 dummy
//    atlas binding so the sampler is valid before
//    loadTextureAtlas() runs, sets gl.clearColor,
//    and installs resizeViewport as the resize
//    callback in canvas.js.
//
//  castRays(player, measure = false)
//    Called every frame from main.js render().
//    Clears the color buffer, binds the program and
//    VAO, uploads the three per-frame uniforms
//    (u_playerPos, u_dir, u_plane), then issues one
//    gl.drawArrays(TRIANGLES, 0, 3) covering the
//    full screen via a procedural fullscreen triangle.
//
//    measure (bool)
//      false — bare draw, zero timing overhead.
//              Returns null.
//      true  — timing active (see GPU timing below).
//
//    main.js passes measure = (_debugMode >= 2) so
//    timing overhead is strictly zero during normal
//    gameplay.  Returns null (Path A always) or ms
//    (Path B, measure=true only).
//
//  resizeViewport(w, h)
//    Installed as canvas.js resize callback.
//    Called by setResolution() on drawing buffer
//    dimension changes.  Updates gl.viewport and
//    re-uploads u_H.  u_segmentCount is map-static.
//    u_dir / u_plane are per-frame (castRays).
//
//  pollGPUTimer() → number | null
//    Path A only.  Non-blocking poll of the previous
//    frame's GPU query.  Returns elapsed ms when
//    ready, null otherwise (not ready, disjoint clock,
//    or Path B active).  Called at the top of each
//    render() before the new frame's castRays().
//
//  gpuTimerSupported() → boolean
//    true  — Path A (EXT_disjoint_timer_query_webgl2)
//    false — Path B (gl.finish CPU fence fallback)
//
//  getGPUInfo() → string
//    GPU name string, read once at initRenderer().
//    Prefers WEBGL_debug_renderer_info (unmasked).
//    Falls back to gl.RENDERER (masked by most
//    browsers).  ANGLE prefix, vendor hex IDs, and
//    "OpenGL Engine" suffixes stripped.  Truncated
//    to 28 chars.  Returns 'unknown' if unavailable.
//
//  getFov() → number
//    Current horizontal FOV in degrees.
//    Cached in _fovDeg, kept in sync by setFov().
//    Zero GL cost.  Read by main.js for debugData.fov.
//
//  setFov(deg)
//    Updates _fovDeg and recomputes _fovHalfTan.
//    u_plane is uploaded per-frame in castRays().
//
//  getFogDist() → number
//    Current fog falloff distance in tile-space.
//    Cached in _fogDistVal, kept in sync by
//    setFogDist().  Read by main.js for debugData.
//
//  setFogDist(dist)
//    Updates _fogDistVal and uploads u_fogDist.
//
//  setFloorMat(mat) / setCeilMat(mat)
//    Upload a resolved material (map.js _resolveMaterial)
//    to the floor or ceiling shader uniforms.
//    Call once after both initRenderer() and loadLevel().
//    mat: { texId, brightness, r, g, b }
//      texId < 0 → solid colour (r/g/b 0–255)
//      texId ≥ 0 → atlas layer; brightness ∈ [−1,1]
//    r/g/b normalised to 0–1 before upload.
//
//  autoDetectResolution(player) → Promise<{w,h,avgMs}>
//    Walks resolution tiers 4K → 480p, measuring rAF
//    cadence.  Commits the first tier where avgMs ≤
//    RAF_BUDGET_MS (18 ms).
//
//  loadTextureAtlas(paths) → Promise<void>
//    Loads wall textures in parallel, scales each to
//    64 × 128 px (Doom wall aspect), uploads as a
//    TEXTURE_2D_ARRAY on unit 1.  UNPACK_FLIP_Y_WEBGL
//    ensures wallV=0 maps to image bottom.  Generates
//    LINEAR_MIPMAP_LINEAR mipmaps.  Re-asserts the
//    u_texAtlas uniform.  Call once after initRenderer().
//
// ─────────────────────────────────────────────
//  GPU timing — two paths
// ─────────────────────────────────────────────
//
//  Path A — EXT_disjoint_timer_query_webgl2
//    Chrome/Edge on localhost or HTTPS.  Async
//    ping-pong query; result is one frame delayed.
//    Zero pipeline stall on both measure paths.
//    castRays() always returns null.
//    main.js reads the result via pollGPUTimer().
//
//  Path B — gl.finish() CPU fence (fallback)
//    Firefox, LAN IP origins, privacy browsers.
//    measure=false → bare draw, no stall, null.
//    measure=true  → draw + gl.finish(), stall
//                    contained inside castRays(),
//                    returns elapsed ms.
//    drawMinimap() and drawDebugOverlay() are timed
//    after castRays() returns — never affected.
//
//  Ping-pong design (Path A)
//    _queries[0/1] alternate via _pendingIdx ^ 1.
//    castRays() writes the non-pending slot.
//    pollGPUTimer() reads the pending slot.
//    _hasSubmitted guards against polling before
//    the first query has been ended.
//
// ─────────────────────────────────────────────
//  Fragment shader — segment texture layout
// ─────────────────────────────────────────────
//  RGBA32F, stride 3 texels per segment:
//    texel i*3+0  (x1, y1, ex, ey)       geometry
//    texel i*3+1  (absNY, r, g, b)        appearance
//    texel i*3+2  (texId, brightness, 0, 0) material
//
//  Inner loop fetches only texel 0 (geometry).
//  Texels 1 and 2 are fetched once after the loop
//  for the winning segment — deferred fetch reduces
//  texel reads from 3×MAX_SEGMENTS to MAX_SEGMENTS+2.
//
//  Intersection: Cramér's rule, branch-free via
//  step() / mix().  denom*denom < DENOM_EPS2 avoids
//  abs().  u_segmentCount drives the loop break so
//  all lanes exit together — no warp divergence.
//
//  MAX_T = 1000.0 replaces INF — ANGLE/D3D lerp()
//  loses precision at INF=1e30, collapsing bestT to 0.
//
//  Wall: lineHeight = u_H / bestT.
//  tiledU = fract(bestU * segLen) — one repeat per
//  tile of segment length.
//  fScale = clamp((1 − fog*0.85)*shade + brightness).
//
//  Floor/ceiling: rowDist = halfH / max(dist, 1.0).
//  worldPos UV = fract(playerPos + rowDist * v_rayDir).
//  Branch-free selection via step() on texId sign.
//
//  Ray direction interpolated from vertex shader:
//  v_rayDir = u_dir + u_plane * pos.x.  camX == NDC x,
//  so the formula is exact at all 3 vertices and
//  hardware-interpolated per-fragment at zero cost.
// ─────────────────────────────────────────────

import { gl, setResizeCallback, setResolution } from './canvas.js';
import {
  WALLS_COUNT,
  buildSegmentTexture
} from './map.js';

let _fovHalfTan = Math.tan(Math.PI / 6);
let _fovDeg = 60;   // degrees — kept in sync with _fovHalfTan for HUD display

// ── setFov(deg) / getFov() ────────────────────────────────────────
// setFov updates the camera plane width for the next castRays() call.
// deg is total horizontal FOV in degrees (e.g. 60, 90, 110).
// u_plane is uploaded per-frame in castRays(), so no GL call is
// needed here — just mutate the module-level values.
// getFov() returns the current FOV in degrees for HUD display.
export function setFov(deg) {
  _fovDeg = deg;
  _fovHalfTan = Math.tan((deg / 2) * Math.PI / 180);
}

export function getFov() {
  return _fovDeg;
}
export function getFovHalfTan() {
  return _fovHalfTan;
}
// ── setFogDist(dist) / getFogDist() ──────────────────────────────
// setFogDist sets the fog falloff distance uniform.  dist is a
// world-space scalar: walls at this distance are fully fogged.
// Uploaded immediately via the cached uniform location.
// getFogDist() returns the current value for HUD display.
let _fogDistVal = 12.0;   // mirrors the gl.uniform1f default in initRenderer

export function setFogDist(dist) {
  _fogDistVal = dist;
  gl.useProgram(_program);
  gl.uniform1f(_uFogDist, dist);
}

export function getFogDist() {
  return _fogDistVal;
}

// ── Vertex shader ─────────────────────────────────────────────────
// Computes the ray direction for each triangle vertex and emits it
// as a smooth varying.  The fragment shader receives the
// hardware-interpolated value directly — no per-fragment trig or
// camX arithmetic needed.
//
// camX == NDC x: both equal (2 * screenX / W) − 1, so
//   rayDir = u_dir + u_plane * pos.x
// is exact at all three vertices and linear across the screen.
//
// u_dir and u_plane are declared here and in the fragment shader.
// In WebGL2 they share the same program-level uniform binding.
const VS_SRC = /* glsl */`#version 300 es
uniform vec2 u_dir;
uniform vec2 u_plane;

out vec2 v_rayDir;

void main() {
  vec2 verts[3];
  verts[0] = vec2(-1.0, -1.0);
  verts[1] = vec2( 3.0, -1.0);
  verts[2] = vec2(-1.0,  3.0);
  vec2 pos    = verts[gl_VertexID];
  gl_Position = vec4(pos, 0.0, 1.0);

  // camX == pos.x (both are NDC x = 2*screenX/W - 1).
  // Interpolation is linear, matching the per-fragment formula exactly.
  v_rayDir = u_dir + u_plane * pos.x;
}`;

const FS_SRC = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;

uniform vec2           u_playerPos;
uniform vec2           u_dir;
uniform vec2           u_plane;
uniform float          u_H;
uniform int            u_segmentCount;
uniform sampler2D      u_segments;
uniform sampler2DArray u_texAtlas;   // wall texture atlas — unit 1

// ── Floor / ceiling material uniforms ────────────────────────────
// texId  < 0  → use color (vec3, pre-normalised 0..1)
// texId  ≥ 0  → sample atlas layer texId, apply brightness offset
// brightness  ∈ [−1, 1]  (json value / 50)
uniform float u_floorTexId;
uniform vec3  u_floorColor;
uniform float u_floorBrightness;
uniform float u_ceilTexId;
uniform vec3  u_ceilColor;
uniform float u_ceilBrightness;

in vec2 v_rayDir;

// MAX_SEGMENTS must match map.js MAX_SEGMENTS (64).
#define MAX_SEGMENTS 64

// MAX_T replaces INF.
// ANGLE (Chrome/Edge on Windows) translates mix() to HLSL lerp():
//   lerp(a,b,t) = a + t*(b-a) — algebraically equal but numerically
//   different for large a.  With INF=1e30 and a real t=5.0, float32
//   loses all precision (ULP(1e30)≈1192) and bestT becomes 0.
//   MAX_T=1000 is safe: map ≤100 tiles, fog hides beyond ~30.
const float MAX_T      = 1000.0;
const float DENOM_EPS2 = 1.0e-20;
const float T_MIN      = 1.0e-4;
uniform float u_fogDist;
const float FOG_AMT    = 0.85;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDist;

void main() {
  vec2 rayDir = v_rayDir;

  float bestT    = MAX_T;
  float hitFound = 0.0;
  float bestI    = 0.0;
  // bestU — parametric hit position along the winning segment [0,1].
  // Tracked via mix() so no re-intersection is needed after the loop.
  float bestU    = 0.0;

  for (int i = 0; i < MAX_SEGMENTS; i++) {
    if (i >= u_segmentCount) break;

    // Stride 3 texels/segment: only geometry needed in the hot loop.
    vec4  geom  = texelFetch(u_segments, ivec2(i * 3, 0), 0);
    float ex    = geom.z;
    float ey    = geom.w;
    float fx    = geom.x - u_playerPos.x;
    float fy    = geom.y - u_playerPos.y;
    float denom = rayDir.x * ey - rayDir.y * ex;

    float valid     = step(DENOM_EPS2, denom * denom);
    float safeDenom = denom + (1.0 - valid);

    float t        = (fx * ey       - fy * ex)       / safeDenom;
    float segParam = (fx * rayDir.y - fy * rayDir.x) / safeDenom;

    float hit = valid
              * step(T_MIN, t)
              * step(0.0,   segParam)
              * step(segParam, 1.0)
              * (1.0 - step(bestT, t));

    bestT    = mix(bestT,    t,          hit);
    bestI    = mix(bestI,    float(i),   hit);
    bestU    = mix(bestU,    segParam,   hit);
    hitFound = max(hitFound, hit);
  }

  // ── Deferred fetch for the winning segment ───────────────────────
  // 3 texels per segment: geometry | appearance | material
  int  winIdx = int(round(bestI));
  vec4 wGeom  = texelFetch(u_segments, ivec2(winIdx * 3,     0), 0);
  vec4 wApp   = texelFetch(u_segments, ivec2(winIdx * 3 + 1, 0), 0);
  vec4 wMeta  = texelFetch(u_segments, ivec2(winIdx * 3 + 2, 0), 0);

  float bestAbsNY = wApp.x   * hitFound;
  vec3  bestCol   = wApp.yzw * hitFound;

  // wMeta.x = texId (-1 = RGB, 0+ = atlas layer)
  // wMeta.y = brightness offset, normalised [−1, 1]
  float texId      = wMeta.x;
  float brightness = wMeta.y;

  // Doom-style U tiling: tile once per tile of segment length.
  float segLen = length(wGeom.zw);
  float tiledU = fract(bestU * segLen);

  // ── Floor / ceiling casting ──────────────────────────────────────
  // In WebGL gl_FragCoord.y=0 is the bottom of the screen.
  //   screenY < halfH  →  floor half
  //   screenY ≥ halfH  →  ceiling half
  //
  // rowDist — distance along the ray to the floor/ceiling plane at
  // this screen row.  Capped at 1.0 to prevent division explosion at
  // the exact horizon pixel (walls cover most horizon pixels anyway).
  //
  // worldPos — tile-space position on the floor/ceiling plane, used
  // directly as UV.  fract() gives tiling within each tile square.
  //
  // v_rayDir is the per-column ray direction interpolated from the
  // vertex shader — identical to what the wall loop uses, so UV
  // alignment between walls and floor/ceiling is exact.

  float screenY  = gl_FragCoord.y;
  float halfH    = u_H * 0.5;
  float isSky    = step(halfH, screenY);

  // ── Floor ───────────────────────────────────────────────────────
  float distFloor   = halfH / max(halfH - screenY, 1.0);
  vec2  floorWorld  = u_playerPos + distFloor * v_rayDir;
  vec2  floorUV     = fract(floorWorld);
  float floorFog    = min(1.0, distFloor / u_fogDist);
  float floorScale  = clamp((1.0 - floorFog * FOG_AMT) + u_floorBrightness, 0.0, 1.0);
  vec3  floorTexC   = texture(u_texAtlas, vec3(floorUV, max(0.0, u_floorTexId))).rgb;
  float useFloorTex = step(0.0, u_floorTexId);
  vec3  floorCo     = mix(u_floorColor, floorTexC, useFloorTex) * floorScale;

  // ── Ceiling ─────────────────────────────────────────────────────
  float distCeil   = halfH / max(screenY - halfH, 1.0);
  vec2  ceilWorld  = u_playerPos + distCeil * v_rayDir;
  vec2  ceilUV     = fract(ceilWorld);
  float ceilFog    = min(1.0, distCeil / u_fogDist);
  float ceilScale  = clamp((1.0 - ceilFog * FOG_AMT) + u_ceilBrightness, 0.0, 1.0);
  vec3  ceilTexC   = texture(u_texAtlas, vec3(ceilUV, max(0.0, u_ceilTexId))).rgb;
  float useCeilTex = step(0.0, u_ceilTexId);
  vec3  ceilCo     = mix(u_ceilColor, ceilTexC, useCeilTex) * ceilScale;

  vec3  bgCo = mix(floorCo, ceilCo, isSky);

  // ── Wall strip ───────────────────────────────────────────────────
  float lineHeight = u_H / bestT;
  float wallTop    = (u_H - lineHeight) * 0.5;
  float wallBottom = (u_H + lineHeight) * 0.5;
  float inStrip    = step(wallTop, screenY) * step(screenY, wallBottom);

  float wallV = clamp((screenY - wallTop) / max(lineHeight, 1.0), 0.0, 1.0);

  float shade  = 0.55 + 0.45 * bestAbsNY;
  float fog    = min(1.0, bestT / u_fogDist);
  // fScale: base lighting from fog + normal shading.
  // brightness is added only for textured segments (0 for RGB segs).
  // clamp keeps the result in [0, 1] so no channel overflows.
  float fScale = clamp((1.0 - fog * FOG_AMT) * shade + brightness, 0.0, 1.0);

  // Branch-free texture / solid-colour selection.
  // safeLayer clamps negative texId to 0 — the atlas sample is
  // discarded by the mix when useTex == 0 so the value is harmless.
  float safeLayer = max(0.0, texId);
  vec3  texSample = texture(u_texAtlas, vec3(tiledU, wallV, safeLayer)).rgb;
  float useTex    = step(0.0, texId) * hitFound;

  vec3  wallCo   = mix(bestCol * fScale, texSample * fScale, useTex);
  float showWall = hitFound * inStrip * step(0.001, bestT);

  outColor = vec4(mix(bgCo, wallCo, showWall), 1.0);

  // ── Distance Packing ──────────────────────────────────────────
  // Packs a float [0, 255] into three bytes (RGB) for RGBA8 storage.
  // This provides ~0.00001 unit precision (1 part in 16.7M).
  float finalDist = isSky > 0.5 ? distCeil : distFloor;
  finalDist = mix(finalDist, bestT, showWall);
  float d = clamp(finalDist, 0.0, 255.0);
  outDist.r = floor(d) / 255.0;
  d = fract(d) * 255.0;
  outDist.g = floor(d) / 255.0;
  outDist.b = fract(d);
  outDist.a = 1.0;
}`;
let _program;
let _vao;
let _uPlayerPos, _uDir, _uPlane;
let _uH;       // cached for resizeViewport
let _uFogDist; // cached for setFogDist
// Floor / ceiling uniform locations — cached at initRenderer()
let _uFloorTexId, _uFloorColor, _uFloorBright;
let _uCeilTexId, _uCeilColor, _uCeilBright;

// ── MRT / Offscreen State ─────────────────────────────────────────
let _fbo;
let _colorTex, _distTex;
let _segTex, _atlasTex; // Cached for per-frame re-binding

export function getColorTex() { return _colorTex; }
export function getDistTex() { return _distTex; }
export function getFbo() { return _fbo; }

// ── GPU info string ───────────────────────────────────────────────
// Read once at initRenderer().  Exported via getGPUInfo().
let _gpuInfo = 'unknown';

// ── GPU timer state ───────────────────────────────────────────────
// _ext          — EXT_disjoint_timer_query_webgl2 or null
// _queries[0/1] — ping-ponged WebGLQuery objects (Path A only)
// _pendingIdx   — slot holding last frame's submitted query (pollable)
//                 the other slot (_pendingIdx ^ 1) is written this frame
// _hasSubmitted — prevents polling before the first query has ended
let _ext = null;
let _queries = [null, null];
let _pendingIdx = 0;
let _hasSubmitted = false;

function _initGPUTimer() {
  _ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!_ext) {
    console.info(
      '[renderer.js] EXT_disjoint_timer_query_webgl2 unavailable — ' +
      'falling back to gl.finish() CPU-fence timing (only when perf overlay is on).'
    );
    return;
  }
  _queries[0] = gl.createQuery();
  _queries[1] = gl.createQuery();
}

// ── _readGPUInfo ──────────────────────────────────────────────────
// Reads the GPU renderer string once.
// Prefers WEBGL_debug_renderer_info (unmasked name) — requires the
// extension to be enabled.  Chrome/Edge grant it on secure origins;
// Firefox blocks it by default.  Falls back to the standard
// gl.RENDERER which most browsers mask to a vendor-generic string.
// Truncated to 28 chars to fit the fixed-width debug panel.
function _readGPUInfo() {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const raw = dbg
    ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const cleaned = (raw || 'unknown')
    .replace(/^ANGLE \(/, '')
    .replace(/\)$/, '')
    .replace(/\s*\(0x[0-9a-fA-F]+\)/g, '')
    .replace(', OpenGL Engine', '')
    .trim();
  _gpuInfo = cleaned.length > 28 ? cleaned.slice(0, 27) + '…' : cleaned;
}

// Returns the GPU identifier string (read-only after init).
export function getGPUInfo() {
  return _gpuInfo;
}

// ── pollGPUTimer (Path A only) ────────────────────────────────────
// Non-blocking poll of the previous frame's GPU query.
// Returns elapsed milliseconds when ready, null otherwise.
// Always returns null on Path B — main.js uses castRays()'s direct
// return value instead.
export function pollGPUTimer() {
  if (!_ext || !_hasSubmitted) return null;

  // GPU_DISJOINT_EXT set means the clock was discontinuous — result
  // invalid.  Reading the parameter also clears the flag.
  if (gl.getParameter(_ext.GPU_DISJOINT_EXT)) return null;

  const q = _queries[_pendingIdx];
  if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return null;

  // Result is nanoseconds — convert to milliseconds.
  return gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
}

// True when Path A (extension query) is active.
// False when falling back to Path B (gl.finish fence).
export function gpuTimerSupported() {
  return _ext !== null;
}

function _compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`[renderer.js] Shader compile error:\n${log}`);
  }
  return s;
}

function _linkProgram(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`[renderer.js] Program link error:\n${log}`);
  }
  gl.detachShader(p, vs);
  gl.detachShader(p, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

export function initRenderer() {
  const vs = _compileShader(gl.VERTEX_SHADER, VS_SRC);
  const fs = _compileShader(gl.FRAGMENT_SHADER, FS_SRC);
  _program = _linkProgram(vs, fs);

  _vao = gl.createVertexArray();
  
  _segTex = buildSegmentTexture(gl);

  gl.useProgram(_program);

  _uH = gl.getUniformLocation(_program, 'u_H');
  _uPlayerPos = gl.getUniformLocation(_program, 'u_playerPos');
  _uDir = gl.getUniformLocation(_program, 'u_dir');
  _uPlane = gl.getUniformLocation(_program, 'u_plane');
  _uFogDist = gl.getUniformLocation(_program, 'u_fogDist');

  // ── Floor / ceiling uniform locations ─────────────────────────
  _uFloorTexId = gl.getUniformLocation(_program, 'u_floorTexId');
  _uFloorColor = gl.getUniformLocation(_program, 'u_floorColor');
  _uFloorBright = gl.getUniformLocation(_program, 'u_floorBrightness');
  _uCeilTexId = gl.getUniformLocation(_program, 'u_ceilTexId');
  _uCeilColor = gl.getUniformLocation(_program, 'u_ceilColor');
  _uCeilBright = gl.getUniformLocation(_program, 'u_ceilBrightness');

  // Defaults match the old hardcoded gradient midpoint colours so the
  // scene looks reasonable before setFloorMat / setCeilMat are called.
  gl.uniform1f(_uFloorTexId, -1.0);
  gl.uniform3f(_uFloorColor, 35 / 255, 28 / 255, 23 / 255);
  gl.uniform1f(_uFloorBright, 0.0);
  gl.uniform1f(_uCeilTexId, -1.0);
  gl.uniform3f(_uCeilColor, 17 / 255, 18 / 255, 50 / 255);
  gl.uniform1f(_uCeilBright, 0.0);

  gl.uniform1i(gl.getUniformLocation(_program, 'u_segments'), 0);
  gl.uniform1i(gl.getUniformLocation(_program, 'u_segmentCount'), WALLS_COUNT);
  gl.uniform1f(_uFogDist, 12.0);

  // ── Dummy texture array (unit 1) ───────────────────────────────
  // Gives u_texAtlas a valid binding before loadTextureAtlas() runs.
  const dummyArray = gl.createTexture();
  _atlasTex = dummyArray;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, _atlasTex);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, 1, 1, 1, 0,
    gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(gl.getUniformLocation(_program, 'u_texAtlas'), 1);

  // Create the offscreen framebuffer for MRT (Color + Distance).
  console.info('[renderer.js] Initializing MRT pipeline...');
  _fbo = gl.createFramebuffer();
  _colorTex = gl.createTexture();
  _distTex = gl.createTexture();

  // Set initial viewport + u_H using the current canvas size.
  // This will also allocate the FBO texture storage.
  resizeViewport(gl.drawingBufferWidth, gl.drawingBufferHeight);

  // Clear colour: opaque black.  With alpha:false on the context this
  // has no effect on compositing, but it guarantees the first-frame
  // clear() call in castRays() produces a defined known-good frame
  // rather than uninitialised GPU memory showing through.
  gl.clearColor(0, 0, 0, 1);

  // Tell canvas.js to call resizeViewport whenever setResolution fires.
  setResizeCallback(resizeViewport);

  // Read GPU info string once — before GPU timer init so both
  // extension queries happen in the same init block.
  _readGPUInfo();

  // Attempt to initialise GPU timer.  Safe to call regardless of support.
  _initGPUTimer();
}

// ── resizeViewport ────────────────────────────────────────────────
// Updates gl.viewport and re-uploads u_H.
// u_segmentCount is map-static and never needs re-uploading.
// u_dir / u_plane are per-frame and handled in castRays().
export function resizeViewport(w, h) {
  gl.viewport(0, 0, w, h);
  gl.useProgram(_program);
  gl.uniform1f(_uH, h);

  // Update FBO textures to match new resolution
  gl.bindTexture(gl.TEXTURE_2D, _colorTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.bindTexture(gl.TEXTURE_2D, _distTex);
  // Use standard RGBA8 instead of R32F for maximum compatibility.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _colorTex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, _distTex, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ── castRays(player, measure) ─────────────────────────────────────
//
//  measure (bool, default false)
//    When false: bare draw call, zero timing overhead.
//                Returns null.
//    When true and Path A: GPU query brackets the draw call.
//                Returns null (result arrives next frame via poll).
//    When true and Path B: gl.finish() stalls after the draw call.
//                Returns elapsed milliseconds.
//
//  The measure flag is driven by (_debugMode >= 2) in main.js, so
//  the gl.finish() stall only occurs when the verbose perf section
//  is open — never during normal gameplay.
//
export function castRays(player, measure = false) {
  // Explicit clear before every draw.
  // With preserveDrawingBuffer:false (default) the spec says the
  // drawing buffer contents are *undefined* after composition.
  // On certain ANGLE/D3D11 paths (Path B — gl.finish fallback,
  // common on Windows when the timer extension is absent) the
  // compositor may present the stale/zeroed buffer before the new
  // drawArrays completes.  Calling clear() gives the compositor a
  // valid fully-opaque black frame to show during any such gap,
  // which is far preferable to transparent-black flicker.
  // Cost: one GPU clear per frame — negligible vs the drawArrays.
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(_program);
  gl.bindVertexArray(_vao);

  // 1. Re-establish texture state for the environment pass.
  // This prevents feedback loops if a previous pass (like sprites)
  // left the distance buffer bound to one of our units.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, _segTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, _atlasTex);

  const sinA = player.sinA;
  const cosA = player.cosA;

  gl.uniform2f(_uPlayerPos, player.pos.x, player.pos.y);
  gl.uniform2f(_uDir, sinA, -cosA);
  gl.uniform2f(_uPlane, cosA * _fovHalfTan, sinA * _fovHalfTan);

  // ── Path A — async GPU query (extension available) ────────────
  if (_ext) {
    if (measure) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.clearBufferfv(gl.COLOR, 0, [0.0, 0.0, 0.0, 1.0]);
      gl.clearBufferfv(gl.COLOR, 1, [1.0, 0.0, 0.0, 1.0]); // 255.0 packed

      gl.beginQuery(_ext.TIME_ELAPSED_EXT, _queries[_pendingIdx ^ 1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.endQuery(_ext.TIME_ELAPSED_EXT);

      _pendingIdx ^= 1;
      _hasSubmitted = true;
      
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, _fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
        0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
        gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      // Path A: Bare draw (measure=false)
      gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.clearBufferfv(gl.COLOR, 0, [0.0, 0.0, 0.0, 1.0]);
      gl.clearBufferfv(gl.COLOR, 1, [1.0, 0.0, 0.0, 1.0]); // 255.0 packed
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, _fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
        0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
        gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return null;
  }

  // ── Path B — gl.finish() CPU fence (extension unavailable) ────
  // When measure=false: bare draw, no stall, full frame rate.
  // When measure=true:  draw + finish, stall contained here.
  //   drawMinimap() and drawDebug() are timed after this returns
  //   so the stall cost never leaks into their measurements.
  if (!measure) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.clearBufferfv(gl.COLOR, 0, [0.0, 0.0, 0.0, 1.0]);
    gl.clearBufferfv(gl.COLOR, 1, [1000.0, 0.0, 0.0, 1.0]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, _fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
      0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
      gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return null;
  }

  const t0 = performance.now();

  gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  // Color (0) -> Black; Distance (1) -> MAX_T (not occluded)
  gl.clearBufferfv(gl.COLOR, 0, [0.0, 0.0, 0.0, 1.0]);
  gl.clearBufferfv(gl.COLOR, 1, [1000.0, 0.0, 0.0, 1.0]);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  gl.finish();
  return performance.now() - t0;
}

// ── present() ─────────────────────────────────────────────────────
// Blits the offscreen color buffer to the hardware framebuffer.
// Call this after all 3D passes (env + sprites) are complete.
export function present() {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, _fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
    0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
    gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ── autoDetectResolution(player) ──────────────────────────────────
//
//  Walks resolution tiers from highest (4K) to lowest (480p),
//  measuring actual rAF delivery cadence at each tier.  Commits
//  the first tier where frames deliver in ≤ RAF_BUDGET_MS (18ms).
//
//  WHY rAF CADENCE OVER gl.finish()
//  ─────────────────────────────────
//  gl.finish() fences GPU draw commands but returns BEFORE the
//  browser compositor transfers the framebuffer for presentation.
//  On Android at 4K this transfer costs 30–40 ms — invisible to
//  gl.finish() — so the previous detector saw ~1 ms shader time
//  and selected 4K while the device delivered only 25 fps.
//
//  The interval between consecutive rAF timestamps is the true
//  wall-clock cost per frame: shader + compositor + vsync.
//  This is what actually determines achievable fps.
//
//  WARMUP frames per tier flush GPU command queue backlog from the
//  previous tier and allow the driver clock to stabilise before
//  measurement begins.
//
//  @param {Player} player — needs valid pos/sinA/cosA for uniforms
//  @returns {Promise<{ w, h, avgMs }>}
export async function autoDetectResolution(player) {
  // Hide the canvas for the duration of detection so the user never sees
  // resolution tiers switching.  The start overlay is still hidden at this
  // point (ui.js keeps it display:none until _showStart() fires after we
  // return), so without this the flicker is fully visible — especially
  // jarring on slower phones that step through several tiers.
  // try/finally guarantees restoration even if detection throws.
  const _canvas = gl.canvas;
  _canvas.style.visibility = 'hidden';

  try {

    // Resolution tiers, highest to lowest.
    const TIERS = [
      [3840, 1920],
      [2560, 1280],
      [1920, 960],
      [1280, 640],
      [960, 480],
    ];

    // 18 ms = 55.5 fps floor.  Gives 1.33 ms of jitter headroom above
    // the 16.67 ms 60fps boundary — devices that genuinely can't hit
    // 60 fps will read well above 18 ms, not just slightly over 16.67.
    const RAF_BUDGET_MS = 18;

    // 3 warmup frames per tier: flushes queued work from the previous
    // tier and lets the driver reach steady-state clock speed.
    const WARMUP = 3;

    // 5 measured frames: ~83 ms at 60 fps, ~200 ms at 25 fps.
    // Enough to smooth out vsync jitter without excessive startup time.
    const MEASURE = 5;

    for (const [w, h] of TIERS) {
      // Switch resolution — fires resizeViewport via _onResize callback.
      setResolution(w, h);

      // Warmup: render frames, don't measure them.
      for (let i = 0; i < WARMUP; i++) {
        await new Promise(r => requestAnimationFrame(r));
        castRays(player, false);
      }

      // Seed prev from the rAF timestamp immediately after warmup,
      // with a real draw call so the compositor has actual work to do.
      let prev = await new Promise(r => requestAnimationFrame(r));
      castRays(player, false);

      // Measure rAF cadence — each delta is wall-clock time for one
      // full presented frame including compositor transfer.
      let total = 0;
      for (let i = 0; i < MEASURE; i++) {
        const ts = await new Promise(r => requestAnimationFrame(r));
        castRays(player, false);
        total += ts - prev;
        prev = ts;
      }

      const avgMs = total / MEASURE;

      console.info(
        `[autoDetect] ${w}×${h}  rAF avg ${avgMs.toFixed(1)} ms` +
        (avgMs <= RAF_BUDGET_MS ? '  ✓ selected' : '  — stepping down')
      );

      if (avgMs <= RAF_BUDGET_MS) {
        // setResolution already committed this tier — return result.
        return { w, h, avgMs };
      }
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
    setResolution(960, 480);
    return { w: 960, h: 480, avgMs: RAF_BUDGET_MS };

  } finally {
    // Restore canvas visibility regardless of which exit path was taken.
    _canvas.style.visibility = '';
  }
}

// ── setFloorMat / setCeilMat ──────────────────────────────────────
//
//  Upload a resolved material object (from map.js _resolveMaterial)
//  to the floor or ceiling uniforms.  Call once after loadLevel()
//  and after initRenderer().
//
//  mat shape: { texId: number, brightness: number, r, g, b }
//    texId < 0  → solid colour (r/g/b used, brightness ignored)
//    texId ≥ 0  → atlas layer; brightness applied on top of fog×shade
//
//  r/g/b are raw 0–255 integers; normalised to 0–1 here before upload.
export function setFloorMat(mat) {
  gl.useProgram(_program);
  gl.uniform1f(_uFloorTexId, mat.texId);
  gl.uniform3f(_uFloorColor, mat.r / 255, mat.g / 255, mat.b / 255);
  gl.uniform1f(_uFloorBright, mat.brightness);
}

export function setCeilMat(mat) {
  gl.useProgram(_program);
  gl.uniform1f(_uCeilTexId, mat.texId);
  gl.uniform3f(_uCeilColor, mat.r / 255, mat.g / 255, mat.b / 255);
  gl.uniform1f(_uCeilBright, mat.brightness);
}

// ── loadTextureAtlas(paths) ───────────────────────────────────────
//
//  Loads wall textures from `paths` in parallel, scales every image
//  to ATLAS_W × ATLAS_H (64×128 — Doom wall aspect ratio), uploads
//  the batch as a TEXTURE_2D_ARRAY on texture unit 1, and re-asserts
//  the u_texAtlas uniform.  Call once after initRenderer().
//
//  UNPACK_FLIP_Y_WEBGL — PNG rows are top-to-bottom; GL V=0 is the
//  texture bottom.  Flipping on upload makes wallV=0 (bottom of the
//  wall strip) map to the bottom row of the image — correct orientation.
//
//  @param {string[]} paths  e.g. ['resource/doom-wall.png', ...]
//  @returns {Promise<void>}
export async function loadTextureAtlas(paths) {
  if (!paths || paths.length === 0) {
    console.info('[renderer.js] No wall textures declared — atlas skipped.');
    return;
  }

  const images = await Promise.all(paths.map(src => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`[renderer.js] Failed to load texture: ${src}`));
    img.src = src;
  })));

  const ATLAS_W = 64;
  const ATLAS_H = 128;

  const offscreen = document.createElement('canvas');
  offscreen.width = ATLAS_W;
  offscreen.height = ATLAS_H;
  const ctx2d = offscreen.getContext('2d');

  const tex = gl.createTexture();
  _atlasTex = tex;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY, 0, gl.RGBA,
    ATLAS_W, ATLAS_H, images.length,
    0, gl.RGBA, gl.UNSIGNED_BYTE, null,
  );

  for (let i = 0; i < images.length; i++) {
    ctx2d.clearRect(0, 0, ATLAS_W, ATLAS_H);
    ctx2d.drawImage(images[i], 0, 0, ATLAS_W, ATLAS_H);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0,
      0, 0, i,
      ATLAS_W, ATLAS_H, 1,
      gl.RGBA, gl.UNSIGNED_BYTE,
      offscreen,
    );
  }

  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.activeTexture(gl.TEXTURE0);

  gl.useProgram(_program);
  gl.uniform1i(gl.getUniformLocation(_program, 'u_texAtlas'), 1);

  console.info(`[renderer.js] Wall atlas: ${images.length} texture(s) at ${ATLAS_W}×${ATLAS_H}.`);
}

