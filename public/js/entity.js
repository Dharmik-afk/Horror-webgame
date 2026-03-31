// ─────────────────────────────────────────────
//  entity.js
//  Base class for all world objects that occupy
//  a position in tile-space: Player, Enemy, etc.
//
//  Properties
//    pos      — { x, y } tile-space float position
//    angle    — facing direction in radians
//              (north = 0, clockwise positive)
//    velocity — { x, y } tile-space float per frame
//    radius   — collision bounding radius in tiles
//
//  Methods
//    update()          — override in subclass, called every frame
//    distanceTo(other) — Euclidean distance to another Entity
//    angleTo(other)    — facing angle toward another Entity,
//                        in the same convention as this.angle
// ─────────────────────────────────────────────

export class Entity {
  constructor(x, y, radius = 0.25) {
    this.pos = { x, y };
    this.angle = 0;
    this.velocity = { x: 0, y: 0 };
    this.radius = radius;
  }

  // Override in subclass — called every frame by the game loop
  update() { }

  distanceTo(other) {
    const dx = other.pos.x - this.pos.x;
    const dy = other.pos.y - this.pos.y;
    return Math.hypot(dx, dy);
  }

  // Returns angle in radians from this entity toward another.
  // Uses north = 0, clockwise positive — consistent with player.angle
  // and renderer.js ray direction convention.
  angleTo(other) {
    return Math.atan2(other.pos.x - this.pos.x, -(other.pos.y - this.pos.y));
  }
}

