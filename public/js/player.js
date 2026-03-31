// ─────────────────────────────────────────────
//  player.js
//  Player state, movement physics, and wall
//  collision with segment-normal push-out.
//
//  Collision algorithm (3 iterations per frame):
//    1. Apply velocity to position unconditionally.
//    2. Loop over all segments in WALLS_FLAT.
//    3. For each segment, project the player centre
//       onto the segment to find the closest point.
//    4. If the distance is less than the player radius,
//       push the centre out along the contact normal
//       and cancel the velocity component into the wall.
//       Whether the tangential component is kept depends
//       on the grazing angle (see below).
//
//  Grazing-angle slide suppression
//  ────────────────────────────────
//  Pure sliding (cancel normal, keep tangent) lets the
//  player creep along a wall they are pressing almost
//  directly into.  The fix: measure what fraction of the
//  velocity is tangential at the moment of contact.
//
//    tangent vector : (-ny,  nx)   — 90° CCW from contact normal
//    vDotT          : dot(v, tangent) = -vx*ny + vy*nx
//    slideRatio     : |vDotT| / |v|   — 0 = head-on, 1 = pure slide
//
//  If slideRatio < SLIDE_THRESHOLD the approach is steep
//  enough that we zero the entire velocity (both components).
//  Above the threshold we keep the full tangential component
//  as before — genuine wall-sliding is unaffected.
//
//  SLIDE_THRESHOLD = 0.25 ≈ cos(75°).  Contacts more than
//  ~75° from perpendicular are treated as slides; contacts
//  within 75° of perpendicular (i.e. the player is heading
//  mostly into the wall) are treated as dead stops.
//
//  No trig is required — everything is derived from the
//  contact normal (nx, ny) already computed during push-out.
//
//  Why brute-force over all segments?
//  ─────────────────────────────────────────────
//  With WALLS_COUNT ≈ 25, 3 iterations × 25 tests
//  = 75 closest-point checks per frame.  Each check
//  is ~10 arithmetic ops on pre-cached local scalars.
//  This is a negligible CPU cost.
//
//  Trig cache (sinA / cosA)
//  ─────────────────────────
//  sin and cos of player.angle are needed every frame
//  by both player.update() (wish vector) and castRays()
//  (uniforms).  Cached immediately after angle mutation.
//
//  All coordinates are tile-space floats.
// ─────────────────────────────────────────────

import { Entity } from './entity.js';
import {
  WALLS_FLAT, WALLS_COUNT,
  SEG_X1, SEG_Y1, SEG_EX, SEG_EY,
  SEG_SIZE
} from './map.js';

export class Player extends Entity {
  // FRICTION_60 is the per-frame multiplier at exactly 60 fps.
  // At other frame rates it is raised to the power (dt * 60) so
  // deceleration is frame-rate independent.
  static FRICTION_60 = 0.82;
  static ACCEL = 0.04;           // tiles / second²  (normalised to 60 fps)
  static LOOK_SENSITIVITY = 0.007;    // radians per drag-pixel per 60fps-frame

  // Fraction of velocity that must be tangential for sliding to be
  // allowed.  Below this threshold the full velocity is cancelled.
  // 0.25 ≈ sin(15°) — contacts shallower than ~15° from the wall
  // surface are stopped dead; steeper approaches slide freely.
  static SLIDE_THRESHOLD = 0.25;

  // Hard speed cap applied after each sub-step's friction pass.
  // Default (0.25) sits just above the natural terminal velocity
  // (~0.22 at ACCEL=0.04, FRICTION=0.82) so it is a transparent
  // no-op at factory settings.  The dev panel can lower it to create
  // a deliberate speed limit or raise it to allow turbo mode.
  static MAX_SPEED = 0.25;

  constructor(x, y) {
    super(x, y, 0.25);
    this.input = { x: 0, y: 0 };
    this.lookDeltaX = 0;

    // Trig cache — sin and cos of this.angle.
    // Initialised here so castRays() can safely read them on the very
    // first frame before update() has run.  angle = 0 at construction
    // (set by Entity), so sin(0) = 0 and cos(0) = 1.
    this.sinA = 0;
    this.cosA = 1;
  }

  onKeyDown(k) {
    switch (k) {
      case 'W': this.input.y = -1; break;
      case 'S': this.input.y = 1; break;
      case 'A': this.input.x = -1; break;
      case 'D': this.input.x = 1; break;
    }
  }

  onKeyUp(k) {
    switch (k) {
      case 'W': case 'S': this.input.y = 0; break;
      case 'A': case 'D': this.input.x = 0; break;
    }
  }

  // dt — elapsed time in seconds since the last frame.
  //      Normalised so that dt=1/60 yields a multiplier of 1.0,
  //      keeping all tuned constants (ACCEL, FRICTION_60, LOOK_SENSITIVITY)
  //      identical in feel to the original fixed-60fps behaviour.
  update(dt = 1 / 60) {
    // Scale factor: 1.0 at 60 fps, 2.0 at 30 fps, etc.
    const s = dt * 60;

    // ── Rotate from look-drag ───────────────────────────────────
    // Scale by s so a given drag distance rotates the same angle/second
    // regardless of frame rate.
    this.angle += this.lookDeltaX * Player.LOOK_SENSITIVITY * s;
    this.lookDeltaX = 0;

    // ── Refresh trig cache ──────────────────────────────────────
    this.sinA = Math.sin(this.angle);
    this.cosA = Math.cos(this.angle);

    // ── World-space wish vector from WASD + facing angle ────────
    const fx = this.sinA;
    const fy = -this.cosA;
    const rx = this.cosA;
    const ry = this.sinA;

    const wx = fx * (-this.input.y) + rx * this.input.x;
    const wy = fy * (-this.input.y) + ry * this.input.x;

    const wlen = Math.hypot(wx, wy) || 1;
    const inx = (wx !== 0 || wy !== 0) ? wx / wlen : 0;
    const iny = (wx !== 0 || wy !== 0) ? wy / wlen : 0;

    const R = this.radius;
    const walls = WALLS_FLAT;
    let px = this.pos.x;
    let py = this.pos.y;
    let vx = this.velocity.x;
    let vy = this.velocity.y;

    // ── Dynamic sub-stepping ────────────────────────────────────
    // The push-out collision is positional (not swept): it detects
    // overlap AFTER the move, not along the path.  Each substep's
    // actual displacement is (vx + halfAx) * ds, NOT vx * ds.
    //
    // The Verlet half-step adds  halfAx = ACCEL * ds * 0.5  BEFORE
    // the position update.  When velocity is near zero (e.g. just
    // after a dead stop, player still pressing into a wall while
    // sliding along it) and ds is large, halfAx dominates:
    //
    //   s = 6 (10 fps dt cap), v ≈ 0  →  steps = 1  →  ds = 6
    //   halfAx = 0.04 × 6 × 0.5 = 0.12
    //   displacement = 0.12 × 6 = 0.72 tiles  (≈ 3 × R)
    //
    // The swept crossing guard catches most cases, but has one
    // blind spot: crossings whose tSeg falls outside [0,1] (the
    // endpoint region).  At 0.72 tiles the player can swing around
    // a segment endpoint and land on the wrong side at dist > R,
    // bypassing both guards.
    //
    // Two-term formula — takes the maximum of:
    //   velocity term    : keeps vx * ds ≤ R * 0.5
    //   acceleration term: keeps halfAx * ds = ACCEL * ds² / 2 ≤ R * 0.5
    //                      solving for ds: ds ≤ sqrt(R / ACCEL) = 2.5
    //                      so steps ≥ s / 2.5
    //
    // At 60 fps (s ≈ 1) terminal velocity (≈ 0.18): 2 substeps.
    // At 30 fps (s ≈ 2): 3 substeps.
    // At 10 fps (s = 6) from rest: 3 substeps (accel term).
    // At 10 fps (s = 6) at terminal: 9 substeps (velocity term).
    // All cases: displacement per substep ≤ R * 0.5 = 0.125 tiles.
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(vx, vy) * s / (R * 0.5)),
      Math.ceil(s / Math.sqrt(R / Player.ACCEL)),
    );
    const ds = s / steps;
    const halfAx = inx * Player.ACCEL * ds * 0.5;
    const halfAy = iny * Player.ACCEL * ds * 0.5;
    // Friction exponent is per-substep, not per-frame, so compounding
    // across all substeps produces exactly FRICTION_60 ** s overall.
    const frictionStep = Player.FRICTION_60 ** ds;

    for (let step = 0; step < steps; step++) {
      // ── Verlet: first half-step accel ─────────────────────────
      vx += halfAx;
      vy += halfAy;

      // ── Apply velocity ────────────────────────────────────────
      // Capture pre-move position for the swept crossing guard below.
      const opx = px;
      const opy = py;
      px += vx * ds;
      py += vy * ds;

      // ── Swept crossing guard ───────────────────────────────────
      // The positional push-out cannot detect a crossing that both
      // starts and ends outside the overlap zone — which is exactly
      // what happens when sliding near a segment endpoint.  The
      // closest-point projection transitions from wall-perpendicular
      // to endpoint-radial at t=0/1, letting the player swing around
      // the endpoint and end up on the wrong side without ever
      // entering the R-radius overlap band.
      //
      // This guard computes the signed distance of both the old and
      // new positions from each wall's infinite line.  A sign change
      // means the path crossed the line.  If the crossing point lies
      // within the segment's parameter range, the position is backed
      // up so it sits at distance R on the correct side and the inward
      // velocity component is cancelled.  Push-out then runs as a
      // secondary safety net for any residual overlap.
      for (let i = 0; i < WALLS_COUNT; i++) {
        const base = i * SEG_SIZE;
        const x1   = walls[base + SEG_X1];
        const y1   = walls[base + SEG_Y1];
        const ex   = walls[base + SEG_EX];
        const ey   = walls[base + SEG_EY];
        const len2 = ex * ex + ey * ey;
        if (len2 < 1e-10) continue;

        // Wall normal — LEFT perpendicular to (ex, ey), unit length.
        const len  = Math.sqrt(len2);
        const wnx  = -ey / len;
        const wny  =  ex / len;

        // Signed distance from the wall's infinite line.
        const dOld = (opx - x1) * wnx + (opy - y1) * wny;
        const dNew = (px  - x1) * wnx + (py  - y1) * wny;

        // No sign change — no crossing.
        if (dOld * dNew >= 0) continue;

        // Interpolate to find where the path crosses d = 0.
        const tCross = dOld / (dOld - dNew);
        const cxp    = opx + tCross * (px - opx);
        const cyp    = opy + tCross * (py - opy);

        // Reject if the crossing point lies outside the segment.
        const tSeg = ((cxp - x1) * ex + (cyp - y1) * ey) / len2;
        if (tSeg < 0 || tSeg > 1) continue;

        // Confirmed wall crossing.  Back the position up so it sits
        // at distance R on the side the player started from.
        const side  = dOld > 0 ? 1 : -1;
        const tStop = (dOld - side * R) / (dOld - dNew);

        if (tStop < 0) {
          // Player was already within R of the wall (e.g. sliding
          // right along it).  Correct only the normal axis displacement
          // so the player stays at R — push-out resolves any residual.
          px -= (dNew - side * R) * wnx;
          py -= (dNew - side * R) * wny;
        } else {
          px = opx + tStop * (px - opx);
          py = opy + tStop * (py - opy);
        }

        // Cancel any velocity directed into the wall.
        const vDotWN = vx * wnx + vy * wny;
        if (vDotWN * side < 0) {
          vx -= vDotWN * wnx;
          vy -= vDotWN * wny;
        }
      }

      // ── Segment push-out collision (3 iterations) ─────────────
      for (let iter = 0; iter < 3; iter++) {
        for (let i = 0; i < WALLS_COUNT; i++) {
          const base = i * SEG_SIZE;
          const x1 = walls[base + SEG_X1];
          const y1 = walls[base + SEG_Y1];
          const ex = walls[base + SEG_EX];
          const ey = walls[base + SEG_EY];
          const len2 = ex * ex + ey * ey;
          if (len2 < 1e-10) continue;

          let t = ((px - x1) * ex + (py - y1) * ey) / len2;
          t = Math.max(0, Math.min(1, t));

          const cpx = x1 + t * ex;
          const cpy = y1 + t * ey;
          const dpx = px - cpx;
          const dpy = py - cpy;
          const dist = Math.hypot(dpx, dpy);

          if (dist < R && dist > 1e-6) {
            // Contact normal — unit vector pointing away from the wall
            const overlap = R - dist;
            const invDist = 1 / dist;
            const nx = dpx * invDist;
            const ny = dpy * invDist;

            // Push player out of penetration depth
            px += nx * overlap;
            py += ny * overlap;

            // ── Velocity response ───────────────────────────────
            // vDotN: how much velocity is directed into the wall.
            // Only act when the player is moving into the wall (< 0).
            const vDotN = vx * nx + vy * ny;
            if (vDotN < 0) {
              // vDotT: tangential component along the wall surface.
              // Tangent = (-ny, nx) — 90° CCW from the contact normal.
              const vDotT = -vx * ny + vy * nx;
              const speed = Math.hypot(vx, vy);

              // slideRatio: fraction of speed that is tangential.
              // Near 0 = heading straight into wall.
              // Near 1 = grazing almost parallel to wall.
              const slideRatio = speed > 1e-6 ? Math.abs(vDotT) / speed : 0;

              if (slideRatio < Player.SLIDE_THRESHOLD) {
                // Steep approach — kill all velocity (dead stop).
                vx = 0;
                vy = 0;
              } else {
                // Shallow approach — cancel only the normal component,
                // preserve the tangential component (standard slide).
                vx -= vDotN * nx;
                vy -= vDotN * ny;
              }
            }
          }
        }
      }

      // ── Verlet: second half-step accel + friction ─────────────
      // Friction damps the already-integrated velocity after the
      // full sub-step accel — standard game-physics convention.
      vx = (vx + halfAx) * frictionStep;
      vy = (vy + halfAy) * frictionStep;

      // ── Hard speed cap ────────────────────────────────────────
      // Applied after friction so the cap does not fight the
      // deceleration curve.  At default MAX_SPEED (0.25) this
      // branch is never taken under normal play.
      const spd = Math.hypot(vx, vy);
      if (spd > Player.MAX_SPEED) {
        const inv = Player.MAX_SPEED / spd;
        vx *= inv;
        vy *= inv;
      }
    }

    this.pos.x = px;
    this.pos.y = py;
    this.velocity.x = vx;
    this.velocity.y = vy;

    // ── Velocity snap to zero when idle ─────────────────────────
    // Checked after all substeps so friction has fully compounded
    // before the snap — avoids prematurely killing momentum.
    if (!this.input.x && !this.input.y &&
      Math.hypot(vx, vy) < 0.001) {
      this.velocity.x = 0;
      this.velocity.y = 0;
    }
  }
}


