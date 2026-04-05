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

// ── Configuration ─────────────────────────────────────────────
const CONFIG = {
  MOUSE_SENS: 0.065,
  TOUCH_SENS: 0.5,
  LOOK_SENSITIVITY: 1.0,
  POINTER_LOCK_ENABLED: true,
  WASD_PAD_ENABLED: true,
};

// ── Device Detection ─────────────────────────────────────────────
const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
if (hasTouch) {
  document.body.classList.add('has-touch');
} else {
  document.body.classList.add('no-touch');
}

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
  keyEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pressKey(keyEl, 'mouse');
  });
  const release = () => releaseKey(keyEl);
  window.addEventListener('mouseup', release);
  keyEl.addEventListener('mouseleave', release);
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
  const pad = document.querySelector('.wasd-pad');
  if (!pad) return;

  pad.addEventListener('touchstart', e => {
    if (!CONFIG.WASD_PAD_ENABLED) return;
    for (const t of e.changedTouches) {
      const keyEl = getKeyAtPoint(t.clientX, t.clientY);
      if (!keyEl) continue;
      e.preventDefault();
      touchKeyMap.set(t.identifier, keyEl);
      touchPressKey(keyEl, t.identifier);
    }
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!CONFIG.WASD_PAD_ENABLED) return;
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
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  pressKey(getKeyEl(e.key), 'keyboard');
});
document.addEventListener('keyup', e => {
  if (!WASD.has(e.key.toLowerCase())) return;
  releaseKey(getKeyEl(e.key));
});

// ── Canvas look-drag (touch OR mouse/pointer) ────────────────────
const lookState = new Map();
let mouseDown = false;
let mouseLastX = 0;
let pointerLocked = false;

function handlePointerLockChange(player) {
  pointerLocked = (document.pointerLockElement === c);
  if (pointerLocked) mouseDown = false;
}

function setupCanvasPointer(player) {
  c.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (document.getElementById('start-overlay').style.display !== 'none') return;
    if (document.getElementById('cfg-overlay').getAttribute('aria-hidden') === 'false') return;

    if (CONFIG.POINTER_LOCK_ENABLED && c.requestPointerLock) {
      try {
        c.requestPointerLock();
      } catch (err) {
        mouseDown = true;
        mouseLastX = e.clientX;
      }
    } else {
      mouseDown = true;
      mouseLastX = e.clientX;
    }
  });

  function onDocumentMouseMove(e) {
    if (pointerLocked) {
      player.lookDeltaX += e.movementX * CONFIG.MOUSE_SENS * CONFIG.LOOK_SENSITIVITY;
    } else if (mouseDown) {
      const dx = e.clientX - mouseLastX;
      player.lookDeltaX += dx * CONFIG.MOUSE_SENS * CONFIG.LOOK_SENSITIVITY;
      mouseLastX = e.clientX;
    }
  }
  document.addEventListener('mousemove', onDocumentMouseMove);

  document.addEventListener('mouseup', e => {
    if (e.button !== 0) return;
    if (!pointerLocked && mouseDown) mouseDown = false;
  });

  window.addEventListener('blur', () => { 
    mouseDown = false; 
    Object.keys(keyMap).forEach(k => {
      if (keyMap[k]) releaseKey(getKeyEl(k));
    });
  });

  document.addEventListener('pointerlockchange', () => handlePointerLockChange(player));
  document.addEventListener('pointerlockerror', () => {
    pointerLocked = false;
    mouseDown = false;
  });

  c.addEventListener('contextmenu', e => e.preventDefault());
}

// ── Public API ───────────────────────────────────────────────────
const inputApi = {
  setLookSensitivity: (v) => { CONFIG.LOOK_SENSITIVITY = v; },
  setMouseSensitivity: (v) => { CONFIG.MOUSE_SENS = v; },
  setTouchSensitivity: (v) => { CONFIG.TOUCH_SENS = v; },
  setPointerLockEnabled: (v) => { 
    CONFIG.POINTER_LOCK_ENABLED = v; 
    if (!v && pointerLocked) document.exitPointerLock();
  },
  setWasdPadVisible: (v) => {
    CONFIG.WASD_PAD_ENABLED = v;
    const pad = document.querySelector('.wasd-pad');
    if (pad) pad.style.display = v ? 'grid' : 'none';
  },
  isTouch: () => hasTouch,
};

window.__input = inputApi;

/**
 * Initialize input handlers.
 * @param {Player} player
 */
export function init(player, options = {}) {
  if (options.lookSensitivity !== undefined) CONFIG.LOOK_SENSITIVITY = options.lookSensitivity;
  if (options.wasdPadVisible !== undefined) inputApi.setWasdPadVisible(options.wasdPadVisible);
  else if (!hasTouch) inputApi.setWasdPadVisible(false);

  document.querySelectorAll('.key').forEach(el => {
    KEY_ELS[el.dataset.key] = el;
    setupKeyMouse(el);
  });

  setupPadTouch();

  if (hasTouch) {
    c.addEventListener('touchstart', e => {
      if (document.getElementById('start-overlay').style.display !== 'none') return;
      if (document.getElementById('cfg-overlay').getAttribute('aria-hidden') === 'false') return;

      e.preventDefault();
      for (const t of e.changedTouches) lookState.set(t.identifier, t.clientX);
    }, { passive: false });

    c.addEventListener('touchmove', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (!lookState.has(t.identifier)) continue;
        const dx = t.clientX - lookState.get(t.identifier);
        player.lookDeltaX += dx * CONFIG.TOUCH_SENS * CONFIG.LOOK_SENSITIVITY;
        lookState.set(t.identifier, t.clientX);
      }
    }, { passive: false });

    const clearLook = (e) => {
      for (const t of e.changedTouches) lookState.delete(t.identifier);
    };
    c.addEventListener('touchend', clearLook, { passive: true });
    c.addEventListener('touchcancel', clearLook, { passive: true });
  }

  setupCanvasPointer(player);

  EventBus.on('keypress', ({ key }) => player.onKeyDown(key));
  EventBus.on('keyrelease', ({ key }) => player.onKeyUp(key));
}

export const input = inputApi;


