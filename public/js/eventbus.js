// ─────────────────────────────────────────────
//  eventbus.js
//  Minimal publish / subscribe event bus.
//  No dependencies — imported by both input.js
//  (emits) and main.js / player.js (listens).
// ─────────────────────────────────────────────

export const EventBus = {
  listeners: {},

  on(event, cb) {
    (this.listeners[event] ??= []).push(cb);
  },

  emit(event, data) {
    (this.listeners[event] ?? []).forEach(cb => cb(data));
  },
};
