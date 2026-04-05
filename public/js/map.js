// ─────────────────────────────────────────────
//  map.js
//  World geometry — loaded from a level JSON file.
//
//  Level JSON schema  (levels/*.json)
//  ────────────────────────────────────────────
//  {
//    meta: {
//      name, version, worldW, worldH,
//      spawn: { x, y, angle },
//      textures: [ "resource/foo.png", ... ]   ← wall texture paths
//                                                 index N = texId N
//    },
//    rooms: [
//      {
//        id: string,
//        floor:   { texId?, brightness?, r?, g?, b? }   ← resolved via _entryMaterial
//        ceiling: { texId?, brightness?, r?, g?, b? }   ← resolved via _entryMaterial
//        light: number,                                 ← future use
//        border: { x, y, w, h, sides?[] | texId? | r?,g?,b? }  ← must be a rectangle
//        geometry: [
//
//          // ── Textured rect (uniform all sides) ──────────────────
//          { type:"rect", x, y, w, h, texId:0, brightness:5 }
//
//          // ── Solid-colour rect (uniform all sides) ──────────────
//          { type:"rect", x, y, w, h, r, g, b }
//
//          // ── Per-side rect — sides[top, right, bottom, left] ────
//          { type:"rect", x, y, w, h, sides:[
//              { texId:0, brightness:10 },
//              { r:120, g:80, b:60 },
//              { texId:2 },
//              { r:200, g:200, b:200 }
//          ]}
//
//          // ── Polygon — per-edge via colors[] ────────────────────
//          { type:"polygon", points:[[x,y],...], colors:[
//              { texId:1, brightness:-5 },
//              { r:80, g:200, b:100 }
//          ]}
//
//          // ── Single segment ─────────────────────────────────────
//          { type:"segment", x1,y1,x2,y2, texId:3, brightness:0 }
//          { type:"segment", x1,y1,x2,y2, r,g,b }
//
//          // ── No material data → missingtexturepng.png ───────────
//          { type:"rect", x, y, w, h }
//
//          // ── Portal (future) ────────────────────────────────────
//          { type:"portal", ... }
//        ]
//      }
//    ]
//  }
//
//  Material resolution (per segment)
//  ────────────────────────────────────────────
//  Priority order (first match wins):
//    1. texId present  → textured; brightness optional (−50..50, default 0)
//    2. r/g/b present  → solid RGB; brightness not applicable
//    3. neither        → missingtexturepng.png; brightness 0
//
//  RGB and texture are mutually exclusive per segment.
//  brightness is clamped to [−50, 50] then normalised to [−1, 1]
//  before upload.  It is added to fScale (fog×shade) in the shader,
//  so positive values brighten and negative values darken.
//
//  TEXTURES array
//  ────────────────────────────────────────────
//  Built from meta.textures plus a guaranteed final entry for
//  missingtexturepng.png (always appended, deduped if already listed).
//  MISSING_TEX_ID is the index of that entry — used when no material
//  data is present on a segment.
//
//  Derived fields (ex, ey, absNY) are NEVER stored in the JSON —
//  they are computed at load time by _deriveSegment().
//
//  Public surface
//  ────────────────────────────────────────────
//  loadLevel(url)          → async; fetches and parses a level JSON,
//                            populates all live exports.
//  buildSegmentTexture(gl) → RGBA32F GPU texture from current WALLS_FLAT.
//  castCenterRay(player)   → CPU Cramér's-rule ray for the debug look-at panel.
//  makeRect(target, x, y, w, h, sides)   → authoring helper
//  makePolygon(target, points, colors)    → authoring helper
//  WALLS / WALLS_FLAT / WALLS_COUNT / ROOMS
//  WORLD_W / WORLD_H / SPAWN / TEXTURES / MISSING_TEX_ID
//  FLOOR_MAT / CEIL_MAT
//
//  WALLS_FLAT layout  (SEG_SIZE = 10 floats / segment)
//  ──────────────────────────────────────────────
//  offset  field       notes
//  ──────  ──────────  ────────────────────────────
//    0     x1          segment start X
//    1     y1          segment start Y
//    2     ex          x2 − x1
//    3     ey          y2 − y1
//    4     absNY       |−ey / length|  (shading term)
//    5     r           red   0–255  (0 when textured)
//    6     g           green 0–255  (0 when textured)
//    7     b           blue  0–255  (0 when textured)
//    8     texId       −1 = solid RGB; 0+ = atlas layer index
//    9     brightness  normalised [−1, 1]; always 0 for RGB segs
//
//  GPU texture layout  (RGBA32F, 3 texels / segment)
//  ──────────────────────────────────────────────
//  texel i*3+0 → (x1, y1, ex, ey)              geometry
//  texel i*3+1 → (absNY, r/255, g/255, b/255)   appearance
//  texel i*3+2 → (texId, brightness, 0, 0)       material
//
//  The inner shader loop fetches only texel 0.  Texels 1 and 2 are
//  fetched once after the loop for the winning segment only.
//
//  Authoring helpers
//  ──────────────────────────────────────────────
//  makeRect(target, x, y, w, h, sides)
//    sides: single material descriptor OR array of 4 [top,right,bottom,left]
//  makePolygon(target, points, colors)
//    colors: one material descriptor per edge
//  Material descriptor: { texId, brightness? } | { r, g, b } | null/undefined
// ─────────────────────────────────────────────

export const MAX_SEGMENTS = 64;

// ── Flat-array field offsets ─────────────────────────────────────
export const SEG_X1         = 0;
export const SEG_Y1         = 1;
export const SEG_EX         = 2;
export const SEG_EY         = 3;
export const SEG_ABSNY      = 4;
export const SEG_R          = 5;
export const SEG_G          = 6;
export const SEG_B          = 7;
export const SEG_TEXID      = 8;   // −1 = solid RGB; 0+ = atlas layer
export const SEG_BRIGHTNESS = 9;   // normalised [−1, 1]; always 0 for RGB segs
export const SEG_SIZE       = 10;

// ── Live world state (mutated by loadLevel) ───────────────────────
export let WORLD_W        = 16;
export let WORLD_H        = 8;
export let WALLS_COUNT    = 0;
export let WALLS          = [];
export let WALLS_FLAT     = new Float32Array(0);
export let ROOMS          = [];
export let SPAWN          = { x: 8.5, y: 4.5, angle: 0 };
export let TEXTURES       = [];   // texture paths → loadTextureAtlas()
export let MISSING_TEX_ID = 0;   // index of missingtexturepng.png in TEXTURES
// Resolved floor/ceiling materials for the active room.
// Populated by loadLevel(); consumed by main.js → setFloorMat/setCeilMat.
export let FLOOR_MAT = { texId: -1, brightness: 0, r: 35, g: 28, b: 23 };
export let CEIL_MAT  = { texId: -1, brightness: 0, r: 17, g: 18, b: 50 };

// ── segment ───────────────────────────────────────────────────────
// Internal factory for a raw segment object before _deriveSegment()
// adds ex / ey / absNY.  All geometry builders (makeRect, makePolygon,
// loadLevel segment case) funnel through here so the shape is uniform.
function segment({ x1 = 0, y1 = 0, x2 = 0, y2 = 0,
                   texId = -1, brightness = 0,
                   r = 255, g = 255, b = 255 } = {}) {
  return { x1, y1, x2, y2, texId, brightness, r, g, b };
}

// ── _entryMaterial ────────────────────────────────────────────────
// Converts a raw JSON entry (or material descriptor) to a normalised
// segment material object ready for upload.
//
// Priority (first match wins):
//   1. entry.texId present → textured
//      brightness clamped to [−50, 50] then normalised to [−1, 1].
//   2. entry.r present     → solid RGB; brightness fixed at 0.
//   3. neither             → missing-texture atlas slot; brightness 0.
//
// Always returns:
//   { texId: number, brightness: number, r: number, g: number, b: number }
//
// texId = −1    → shader uses r/g/b directly.
// texId ≥  0    → shader samples atlas layer texId; r/g/b are 0.
function _entryMaterial(entry) {
  const _resolve = (desc) => {
    if (desc != null && desc.texId != null) {
      const raw        = typeof desc.brightness === 'number' ? desc.brightness : 0;
      const brightness = Math.max(-50, Math.min(50, raw)) / 50;
      return { texId: desc.texId, brightness, r: 0, g: 0, b: 0 };
    }
    if (desc != null && desc.r !== undefined) {
      return { texId: -1, brightness: 0, r: desc.r, g: desc.g, b: desc.b };
    }
    // No usable material data — fall back to the missing-texture slot.
    return { texId: MISSING_TEX_ID, brightness: 0, r: 0, g: 0, b: 0 };
  };

  if (entry != null && entry.texId != null) {
    return _resolve({ texId: entry.texId, brightness: entry.brightness ?? 0 });
  }
  if (entry != null && entry.r !== undefined) {
    return _resolve({ r: entry.r, g: entry.g, b: entry.b });
  }
  return _resolve(null); // triggers missing-texture fallback
}

// ── makeRect ──────────────────────────────────────────────────────
// Appends four axis-aligned segments forming a closed rectangle.
//
// @param {object[]} target
// @param {number}   x, y   top-left tile position
// @param {number}   w, h   dimensions in tiles
// @param {object|object[]|null} sides
//   null / undefined     → missing texture on all four sides
//   single descriptor    → same material on all four sides
//   array of 4           → [top, right, bottom, left] independently
export function makeRect(target, x, y, w, h, sides = null) {
  const arr = Array.isArray(sides)
    ? sides
    : [sides, sides, sides, sides];

  // Vertex order: top, right, bottom, left
  const coords = [
    [x,     y,     x + w, y    ],
    [x + w, y,     x + w, y + h],
    [x + w, y + h, x,     y + h],
    [x,     y + h, x,     y    ],
  ];

  for (let i = 0; i < 4; i++) {
    const [x1, y1, x2, y2] = coords[i];
    const mat = _entryMaterial(arr[i] ?? null);
    target.push(segment({ x1, y1, x2, y2, ...mat }));
  }
}

// ── makePolygon ───────────────────────────────────────────────────
// Appends N segments from an ordered vertex list, closing back to
// the first point.  One material descriptor per edge (colors[i]).
//
// @param {object[]} target
// @param {[number, number][]} points
// @param {object[]} colors  one material descriptor per edge
export function makePolygon(target, points, colors) {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    const mat = _entryMaterial(colors?.[i] ?? null);
    target.push(segment({ x1, y1, x2, y2, ...mat }));
  }
}

// ── _deriveSegment ────────────────────────────────────────────────
// Computes and attaches ex, ey, and absNY to a segment object.
// Called after every push to newWalls — never stored in JSON.
function _deriveSegment(seg) {
  const ex  = seg.x2 - seg.x1;
  const ey  = seg.y2 - seg.y1;
  const len = Math.hypot(ex, ey) || 1;
  seg.ex    = ex;
  seg.ey    = ey;
  seg.absNY = Math.abs(-ey / len);
}

// ── _rebuildFlat ──────────────────────────────────────────────────
// Re-packs WALLS into WALLS_FLAT after loadLevel() finishes building
// the full segment list.  Called once per level load.
function _rebuildFlat() {
  WALLS_FLAT = new Float32Array(WALLS_COUNT * SEG_SIZE);
  for (let i = 0; i < WALLS_COUNT; i++) {
    const s    = WALLS[i];
    const base = i * SEG_SIZE;
    WALLS_FLAT[base + SEG_X1]         = s.x1;
    WALLS_FLAT[base + SEG_Y1]         = s.y1;
    WALLS_FLAT[base + SEG_EX]         = s.ex;
    WALLS_FLAT[base + SEG_EY]         = s.ey;
    WALLS_FLAT[base + SEG_ABSNY]      = s.absNY;
    WALLS_FLAT[base + SEG_R]          = s.r;
    WALLS_FLAT[base + SEG_G]          = s.g;
    WALLS_FLAT[base + SEG_B]          = s.b;
    WALLS_FLAT[base + SEG_TEXID]      = s.texId;
    WALLS_FLAT[base + SEG_BRIGHTNESS] = s.brightness;
  }
}

// ── buildSegmentTexture ───────────────────────────────────────────
// Packs WALLS_FLAT into a single RGBA32F texture for the GPU.
//
// 3 texels per segment:
//   texel i*3+0 → (x1, y1, ex, ey)              geometry
//   texel i*3+1 → (absNY, r/255, g/255, b/255)   appearance
//   texel i*3+2 → (texId, brightness, 0, 0)       material
//
// The inner shader loop fetches only texel 0.  Texels 1 and 2 are
// fetched once after the loop for the winning segment (deferred fetch).
//
// texId  = −1.0 → solid RGB
// texId  ≥  0.0 → atlas layer
// brightness ∈ [−1, 1] → added to fScale in the shader
//
// @param {WebGL2RenderingContext} gl
// @returns {WebGLTexture}
export function buildSegmentTexture(gl) {
  if (WALLS_COUNT > MAX_SEGMENTS) {
    throw new Error(
      `[map.js] WALLS_COUNT (${WALLS_COUNT}) exceeds MAX_SEGMENTS (${MAX_SEGMENTS}). ` +
      'Increase MAX_SEGMENTS in map.js and the fragment shader #define.'
    );
  }

  const texWidth = MAX_SEGMENTS * 3;
  const data     = new Float32Array(texWidth * 4);

  for (let i = 0; i < WALLS_COUNT; i++) {
    const src = i * SEG_SIZE;
    const t0  = i * 3 * 4;
    const t1  = t0 + 4;
    const t2  = t0 + 8;

    data[t0]     = WALLS_FLAT[src + SEG_X1];
    data[t0 + 1] = WALLS_FLAT[src + SEG_Y1];
    data[t0 + 2] = WALLS_FLAT[src + SEG_EX];
    data[t0 + 3] = WALLS_FLAT[src + SEG_EY];

    data[t1]     = WALLS_FLAT[src + SEG_ABSNY];
    data[t1 + 1] = WALLS_FLAT[src + SEG_R] / 255;
    data[t1 + 2] = WALLS_FLAT[src + SEG_G] / 255;
    data[t1 + 3] = WALLS_FLAT[src + SEG_B] / 255;

    data[t2]     = WALLS_FLAT[src + SEG_TEXID];
    data[t2 + 1] = WALLS_FLAT[src + SEG_BRIGHTNESS];
    data[t2 + 2] = 0;
    data[t2 + 3] = 0;
  }

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0,
    gl.RGBA32F,
    texWidth, 1, 0,
    gl.RGBA, gl.FLOAT,
    data
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);

  return tex;
}

// ── loadLevel ─────────────────────────────────────────────────────
// Fetches a level JSON file, parses it, and populates all live exports.
//
// Startup order matters:
//   1. TEXTURES and MISSING_TEX_ID are set first so _entryMaterial()
//      can resolve fallback atlas slots during geometry parsing.
//   2. FLOOR_MAT / CEIL_MAT are resolved from the first room before
//      iterating geometry.
//   3. Room border segments are emitted before interior geometry so
//      they occupy the lowest indices in WALLS[].
//
// @param {string} url
// @returns {Promise<object>}  the raw parsed JSON (for caller inspection)
export async function loadLevel(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[map.js] Failed to load level: ${url} (${res.status})`);
  }
  const data = await res.json();

  const { meta, rooms } = data;

  WORLD_W = meta.worldW ?? 16;
  WORLD_H = meta.worldH ?? 8;
  SPAWN   = { x: meta.spawn.x, y: meta.spawn.y, angle: meta.spawn.angle ?? 0 };
  ROOMS   = rooms;

  // ── Build TEXTURES + MISSING_TEX_ID ─────────────────────────────
  // missingtexturepng.png is always the last slot (deduped if the level
  // already lists it).  Must be assigned before _entryMaterial() is
  // called so the fallback index is valid during geometry parsing.
  const MISSING_PATH = 'resource/missingtexturepng.png';
  const base         = (meta.textures ?? []).filter(p => p !== MISSING_PATH);
  TEXTURES           = [...base, MISSING_PATH];
  MISSING_TEX_ID     = TEXTURES.length - 1;

  // ── Floor / ceiling materials ────────────────────────────────────
  // Resolved from the first room.  Multi-room levels will update these
  // on room transition (future work).
  const firstRoom = rooms[0];
  FLOOR_MAT = _entryMaterial(firstRoom?.floor   ?? null);
  CEIL_MAT  = _entryMaterial(firstRoom?.ceiling ?? null);

  // ── Parse geometry ───────────────────────────────────────────────
  const newWalls = [];
  const scratch  = [];

  for (const room of rooms) {
    // ── Room border ──────────────────────────────────────────────
    // Must be a rectangle.  sides[] takes priority over a uniform
    // material on the border entry itself.
    scratch.length = 0;
    const border      = room.border;
    const borderSides = border.sides ?? _entryMaterial(border);
    makeRect(scratch, border.x, border.y, border.w, border.h, borderSides);
    for (const s of scratch) {
      s.roomId = room.id;
      _deriveSegment(s);
      newWalls.push(s);
    }

    // ── Interior geometry ────────────────────────────────────────
    for (const entry of room.geometry) {
      scratch.length = 0;

      switch (entry.type) {

        case 'rect': {
          // sides[] → per-side materials; otherwise uniform from entry fields.
          const sides = entry.sides ?? _entryMaterial(entry);
          makeRect(scratch, entry.x, entry.y, entry.w, entry.h, sides);
          break;
        }

        case 'polygon':
          makePolygon(scratch, entry.points, entry.colors ?? []);
          break;

        case 'segment': {
          const mat = _entryMaterial(entry);
          scratch.push(segment({ ...entry, ...mat }));
          break;
        }

        case 'portal':
          // Portals are parsed but not yet emitted as geometry (future).
          continue;

        default:
          console.warn(
            `[map.js] Unknown geometry type "${entry.type}" in room "${room.id}" — skipped.`
          );
          continue;
      }

      for (const s of scratch) {
        s.roomId = room.id;
        _deriveSegment(s);
        newWalls.push(s);
      }
    }
  }

  WALLS       = newWalls;
  WALLS_COUNT = newWalls.length;
  _rebuildFlat();

  console.info(
    `[map.js] Loaded "${meta.name}" — ` +
    `${rooms.length} room(s), ${WALLS_COUNT} solid segment(s), ` +
    `${TEXTURES.length} texture(s) (missing slot: ${MISSING_TEX_ID}).`
  );

  return data;
}

/**
 * Casts a single ray from the player along their exact facing direction
 * and returns the closest wall segment it hits.
 * @param {Player} player
 * @returns {object|null} hit data { segIndex, dist, u, seg }
 */
export function castCenterRay(player) {
  const rx = player.sinA;
  const ry = -player.cosA;

  let bestT = Infinity;
  let bestI = -1;
  let bestU = 0;

  for (let i = 0; i < WALLS_COUNT; i++) {
    const base = i * SEG_SIZE;
    const x1   = WALLS_FLAT[base + SEG_X1];
    const y1   = WALLS_FLAT[base + SEG_Y1];
    const ex   = WALLS_FLAT[base + SEG_EX];
    const ey   = WALLS_FLAT[base + SEG_EY];

    const fx    = x1 - player.pos.x;
    const fy    = y1 - player.pos.y;
    const denom = rx * ey - ry * ex;

    if (denom * denom < 1e-20) continue;   // parallel / degenerate

    const t = (fx * ey - fy * ex) / denom;
    const u = (fx * ry - fy * rx) / denom;

    if (t < 1e-4 || u < 0 || u > 1) continue;
    if (t < bestT) {
      bestT = t;
      bestI = i;
      bestU = u;
    }
  }

  if (bestI === -1) return null;

  return {
    segIndex : bestI,
    dist     : bestT,
    u        : bestU,
    seg      : WALLS[bestI],
  };
}

