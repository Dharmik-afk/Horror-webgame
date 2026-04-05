// input.js
// Unified input layer: on-screen WASD pad (mouse + touch), physical keyboard,
// canvas look (mobile touch OR desktop mouse/pointer lock).
//
// Mobile look  -> touchmove deltas (Touch API)
// Desktop look -> Pointer Lock API (movementX) with click-and-drag fallback
//
// Integrates with existing EventBus and player.lookDeltaX accumulator.

import { c } from './canvas.js';
import { EventBus } from './eventbus.js';

// ── Internal key state ───────────────────────────────────────────
const keyMap = {};              // current pressed state by char
const KEY_ELS = {};             // cached mapping char -> DOM element

function getKeyEl(k) {
  return KEY_ELS[k.toLowerCase()] ?? null;
}

function pressKey(keyEl, source) {
  if (!keyEl) return;
  const k = keyEl.dataset.key;
  if (keyMap[k]) return;
  keyMap[k] = true;
  keyEl.classList.add('pressed');
  const ripple = document.createElement('div');
  ripple.className = 'ripple';
  keyEl.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
  // keep payload small: only key is emitted
  EventBus.emit('keypress', { key: k.toUpperCase() });
}

function releaseKey(keyEl) {
  if (!keyEl) return;
  const k = keyEl.dataset.key;
  if (!keyMap[k]) return;
  keyMap[k] = false;
  keyEl.classList.remove('pressed');
  EventBus.emit('keyrelease', { key: k.toUpperCase() });
}

// ── WASD on-screen pad — mouse ───────────────────────────────────
function setupKeyMouse(keyEl) {
  keyEl.addEventListener('mousedown', () => pressKey(keyEl, 'mouse'));
  keyEl.addEventListener('mouseup', () => releaseKey(keyEl));
  keyEl.addEventListener('mouseleave', () => releaseKey(keyEl));
}

// ── WASD on-screen pad — touch (global, cross-key drag) ──────────
const touchKeyMap = new Map();  // touchId -> keyEl (or null)
const keyTouches = new Map();   // keyEl -> Set(touchId)

function getKeyAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('.key') : null;
}

function touchPressKey(keyEl, touchId) {
  if (!keyTouches.has(keyEl)) keyTouches.set(keyEl, new Set());
  keyTouches.get(keyEl).add(touchId);
  pressKey(keyEl, 'touch');
}

function touchReleaseKey(keyEl, touchId) {
  const set = keyTouches.get(keyEl);
  if (!set) return;
  set.delete(touchId);
  if (set.size === 0) {
    keyTouches.delete(keyEl);
    releaseKey(keyEl);
  }
}

function setupPadTouch() {
  // touchstart — only handle touches landing on a .key element
  document.addEventListener('touchstart', e => {
    for (const t of e.changedTouches) {
      const keyEl = getKeyAtPoint(t.clientX, t.clientY);
      if (!keyEl) continue;
      e.preventDefault();                          // suppress scroll / tap-highlight
      touchKeyMap.set(t.identifier, keyEl);
      touchPressKey(keyEl, t.identifier);
    }
  }, { passive: false });

  // touchmove — support cross-key drag (swap press)
  document.addEventListener('touchmove', e => {
    let handled = false;
    for (const t of e.changedTouches) {
      if (!touchKeyMap.has(t.identifier)) continue;
      handled = true;
      const prevKey = touchKeyMap.get(t.identifier);
      const nextKey = getKeyAtPoint(t.clientX, t.clientY);
      if (nextKey === prevKey) continue;
      if (prevKey) touchReleaseKey(prevKey, t.identifier);
      if (nextKey) touchPressKey(nextKey, t.identifier);
      touchKeyMap.set(t.identifier, nextKey ?? null);
    }
    if (handled) e.preventDefault();
  }, { passive: false });

  function handleTouchEnd(e) {
    for (const t of e.changedTouches) {
      const keyEl = touchKeyMap.get(t.identifier);
      if (keyEl) touchReleaseKey(keyEl, t.identifier);
      touchKeyMap.delete(t.identifier);
    }
  }
  document.addEventListener('touchend', handleTouchEnd, { passive: true });
  document.addEventListener('touchcancel', handleTouchEnd, { passive: true });
}

// ── Physical keyboard ────────────────────────────────────────────
const WASD = new Set(['w', 'a', 's', 'd']);
document.addEventListener('keydown', e => {
  if (!WASD.has(e.key.toLowerCase()) || e.repeat) return;
  pressKey(getKeyEl(e.key), 'keyboard');
});
document.addEventListener('keyup', e => {
  if (!WASD.has(e.key.toLowerCase())) return;
  releaseKey(getKeyEl(e.key));
});

// ── Canvas look-drag (touch OR mouse/pointer) ────────────────────
// lookState: touchId -> lastClientX (touch look)
const lookState = new Map();

// Sensitivity tuning: adjust to taste. Touch usually needs a larger multiplier.
const MOUSE_SENS = 0.002;   // multiply raw px delta -> look units
const TOUCH_SENS = 0.5;     // multiply touch px delta -> look units

// Mouse/pointer state
let mouseDown = false;      // fallback drag mode (when pointer lock not available)
let mouseLastX = 0;
let pointerLocked = false;

/**
 * Pointer lock change handler.
 * @param {Player} player
 */
function handlePointerLockChange(player) {
  pointerLocked = (document.pointerLockElement === c);
  if (pointerLocked) {
    // clear fallback state when lock engages
    mouseDown = false;
  }
}

/**
 * Setup mouse / pointer handlers for the canvas.
 * @param {Player} player
 */
function setupCanvasPointer(player) {
  // On pointerlock-supported browsers we request lock on user gesture (mousedown).
  // Fallback: if requestPointerLock isn't present or is denied, enable drag fallback.
  c.addEventListener('mousedown', e => {
    if (e.button !== 0) return; // only left click initiates look
    e.preventDefault();

    if (c.requestPointerLock) {
      // request pointer lock; if denied the pointerlockerror event will fire
      try {
        c.requestPointerLock();
      } catch (err) {
        // requestPointerLock may throw in some contexts; fallback to drag
        mouseDown = true;
        mouseLastX = e.clientX;
      }
    } else {
      // no pointer lock support — enable drag fallback
      mouseDown = true;
      mouseLastX = e.clientX;
    }
  });

  // Mousemove: when pointer locked use movementX, otherwise use drag delta when mouseDown.
  function onDocumentMouseMove(e) {
    if (pointerLocked) {
      // movementX is raw delta (can be negative), scale and accumulate
      player.lookDeltaX += e.movementX * MOUSE_SENS;
    } else if (mouseDown) {
      const dx = e.clientX - mouseLastX;
      player.lookDeltaX += dx * MOUSE_SENS;
      mouseLastX = e.clientX;
    }
  }
  // Use document to catch movement while pointer locked
  document.addEventListener('mousemove', onDocumentMouseMove);

  // mouseup: clear drag fallback. If pointer is locked we keep lock (user presses Esc to release).
  document.addEventListener('mouseup', e => {
    if (e.button !== 0) return;
    if (!pointerLocked && mouseDown) mouseDown = false;
    // If you prefer to exit pointer lock on mouseup, call document.exitPointerLock() here.
  });

  // If the cursor leaves the canvas while dragging, cancel the drag fallback.
  c.addEventListener('mouseleave', () => {
    if (!pointerLocked) mouseDown = false;
  });

  // Keep drag state cleared on window blur
  window.addEventListener('blur', () => { mouseDown = false; });

  // pointer lock events
  document.addEventListener('pointerlockchange', () => handlePointerLockChange(player));
  document.addEventListener('pointerlockerror', () => {
    // pointer lock failed -> ensure no stale drag/lock state
    pointerLocked = false;
    mouseDown = false;
  });

  // Optional: prevent right-click context menu on canvas while playing
  c.addEventListener('contextmenu', e => e.preventDefault());
}

/**
 * Initialize input handlers.
 * @param {Player} player
 */
export function init(player) {
  // Pre-cache .key elements into KEY_ELS (data-key attribute)
  document.querySelectorAll('.key').forEach(el => {
    KEY_ELS[el.dataset.key] = el;
    setupKeyMouse(el);
  });

  // Touch pad global handlers (WASD on-screen)
  setupPadTouch();

  // Wire EventBus → player methods
  EventBus.on('keypress', ({ key }) => player.onKeyDown(key));
  EventBus.on('keyrelease', ({ key }) => player.onKeyUp(key));

  // Canvas touch-look (mobile) — unchanged logic but scaled by TOUCH_SENS
  c.addEventListener('touchstart', e => {
    e.preventDefault();
    for (const t of e.changedTouches) lookState.set(t.identifier, t.clientX);
  }, { passive: false });

  c.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (!lookState.has(t.identifier)) continue;
      const dx = t.clientX - lookState.get(t.identifier);
      player.lookDeltaX += dx * TOUCH_SENS;
      lookState.set(t.identifier, t.clientX);
    }
  }, { passive: false });

  function clearLook(e) {
    for (const t of e.changedTouches) lookState.delete(t.identifier);
  }
  c.addEventListener('touchend', clearLook, { passive: true });
  c.addEventListener('touchcancel', clearLook, { passive: true });

  // Canvas mouse/pointer support (desktop) — pointer lock preferred, drag fallback otherwise
  setupCanvasPointer(player);
}
