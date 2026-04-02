/**
 * @file ui.js
 * @description Core "Base" UI script providing an ImGui-inspired programmatic API.
 *              Builds the settings and pause menu dynamically rather than relying
 *              on hardcoded HTML structures.
 *
 * ─── Architecture notes ─────────────────────────────────────────────────────
 *
 *  This file intentionally uses no ES-module syntax (no import/export).
 *  It runs in the global scope so that main.js (an ES module) can reach
 *  shared state through explicit window.* properties:
 *
 *    window._cfgPanel      { open(ctx), close() }   — settings panel API
 *    window._resDropdown   { selectValue, LABELS, list } — resolution sync
 *    window._showStart()   — called by main.js once autoDetect resolves
 *    window._onResDetected(value) — called by main.js to badge the chosen res
 *    window.UI             { section, toggle, slider, dropdown } — builder API
 *
 *  Engine calls go the other way through window.__raycaster, which is set by
 *  main.js after the WebGL context is ready. All UI calls guard with optional
 *  chaining (window.__raycaster?.method()) so it never throws pre-engine.
 *
 * ─── Dynamic settings system ────────────────────────────────────────────────
 *
 *  Settings state is owned by the internal `state` and `configs` objects — the
 *  DOM is never the source of truth. Constraint rules are declared via options
 *  passed to the API (e.g. `UI.toggle(..., { requires: 'devMode' })`):
 *
 *    requires          The row is force-disabled or hidden whenever the named
 *                      parent key is false.
 *
 *    whenAbsent        Controls what happens when `requires` is unmet.
 *                      'disable' (default) — row stays visible but is dimmed
 *                        and non-interactive (.cfg-row-disabled).
 *                      'hide' — row is removed from layout (.cfg-row-hidden).
 *                      Children inherit the most restrictive ancestor mode.
 *
 *    group             Named mutual-exclusion group. Toggling a member ON
 *                      automatically turns every other member OFF.
 *
 *  DOM changes (.cfg-row-disabled / .cfg-row-hidden) are always derived from
 *  state via _syncDom(), never written ad-hoc.
 */

(function () {
  'use strict';

  // ── Build flag ─────────────────────────────────────────────────────────
  const IS_DEV = true;
  const DEV_FLAGS = { IS_DEV };

  // ── Internal State ────────────────────────────────────────────────────
  const state = {};
  const configs = {};
  const sections = [];
  let currentSection = null;

  // ── DOM Elements ──────────────────────────────────────────────────────
  const overlay = document.getElementById('cfg-overlay');
  const panel = document.getElementById('cfg-panel');
  const nav = document.querySelector('.cfg-nav');
  const content = document.getElementById('cfg-content');
  const titleEl = document.querySelector('.cfg-title-text');
  const cfgBtn = document.getElementById('cfg-btn');
  const closeBtn = document.getElementById('cfg-close-btn');
  const resumeBtn = document.getElementById('cfg-resume-btn');

  // ── Registration ──────────────────────────────────────────────────────

  /**
   * Defines a setting and its constraints.
   */
  function defineSetting(key, config) {
    configs[key] = config;
    state[key] = config.default ?? false;
  }

  // ── Visibility resolution ─────────────────────────────────────────────

  function _resolveVisibility(key) {
    const cfg = configs[key];
    if (cfg?.flagGate && !DEV_FLAGS[cfg.flagGate]) return 'hide';

    let current = key;
    let result = 'on';

    while (true) {
      const c = configs[current];
      if (!c?.requires) break;

      const parentCfg = configs[c.requires];
      if (parentCfg?.flagGate && !DEV_FLAGS[parentCfg.flagGate]) return 'hide';

      const parentOn = state[c.requires] === true;
      if (!parentOn) {
        const mode = c.whenAbsent ?? 'disable';
        result = (mode === 'hide' || result === 'hide') ? 'hide' : 'disable';
      }
      current = c.requires;
    }
    return result;
  }

  // ── DOM sync ──────────────────────────────────────────────────────────

  function _syncDom(key) {
    const cfg = configs[key];
    if (!cfg) return;

    const el = document.getElementById(cfg.id);
    if (!el) return;

    const visibility = _resolveVisibility(key);
    const blocked = visibility !== 'on';

    if (cfg.isSection) {
      el.classList.toggle('cfg-row-hidden', visibility === 'hide');
      const navBtn = document.getElementById(cfg.navId);
      if (navBtn) navBtn.classList.toggle('cfg-row-hidden', visibility === 'hide');
      return;
    }

    if (el.type === 'checkbox') {
      el.checked = blocked ? false : state[key];
    } else if (el.type === 'range') {
      el.value = state[key];
      const valSpan = document.getElementById(`val-${key}`);
      if (valSpan) {
        valSpan.textContent = cfg.format ? cfg.format(state[key]) : state[key];
      }
    }
    el.disabled = blocked;

    const row = el.closest('.cfg-3d-row') || el.closest('.cfg-toggle-row') || el.closest('.cfg-slider-row');
    if (row) {
      row.classList.toggle('cfg-row-hidden', visibility === 'hide');
      row.classList.toggle('cfg-row-disabled', visibility === 'disable');
    }
  }

  function _syncSubtree(parentKey, parentValue) {
    for (const [childKey, childCfg] of Object.entries(configs)) {
      if (childCfg.requires !== parentKey) continue;
      if (!parentValue && state[childKey]) {
        state[childKey] = false;
        childCfg.onChange?.(false);
      }
      _syncDom(childKey);
      _syncSubtree(childKey, state[childKey]);
    }
  }

  function set(key, value) {
    const cfg = configs[key];
    if (!cfg) return;

    if (_resolveVisibility(key) !== 'on' && typeof value === 'boolean') value = false;

    state[key] = value;
    _syncDom(key);

    if (cfg.group && value) {
      for (const [otherKey, otherCfg] of Object.entries(configs)) {
        if (otherKey !== key && otherCfg.group === cfg.group && state[otherKey]) {
          state[otherKey] = false;
          _syncDom(otherKey);
          otherCfg.onChange?.(false);
        }
      }
    }

    _syncSubtree(key, value);
    cfg.onChange?.(value);
  }

  // ── UI Factory (ImGui-style API) ──────────────────────────────────────

  const UI = {
    /**
     * Start defining a new section.
     */
    section: function (title, iconSvg, id, optionsOrCallback, callbackOrUndefined) {
      const sectId = `sect-${id}`;
      const navBtnId = `nav-${id}`;

      let options = {};
      let callback = optionsOrCallback;
      if (typeof callbackOrUndefined === 'function') {
        options = optionsOrCallback;
        callback = callbackOrUndefined;
      }

      // Create Nav Button
      const navBtn = document.createElement('button');
      navBtn.className = 'cfg-nav-item';
      navBtn.id = navBtnId;
      navBtn.dataset.target = sectId;
      navBtn.innerHTML = `${iconSvg} ${title}`;
      navBtn.onclick = () => activateSection(sectId);
      // Insert before the spacer
      nav.insertBefore(navBtn, document.querySelector('.cfg-nav-spacer'));

      // Create Section Container
      const sect = document.createElement('section');
      sect.className = 'cfg-section';
      sect.id = sectId;
      sect.innerHTML = `<div class="cfg-section-heading">${iconSvg} ${title}</div>`;
      content.appendChild(sect);

      defineSetting(`sect-${id}`, { id: sectId, isSection: true, navId: navBtnId, ...options });

      currentSection = sect;
      callback();
      currentSection = null;

      sections.push({ id: sectId, navId: navBtnId });
    },

    toggle: function (label, key, options = {}) {
      const id = `toggle-${key}`;
      defineSetting(key, { id, ...options });

      const row = document.createElement('div');
      row.className = 'cfg-toggle-row cfg-3d-row';
      row.innerHTML = `
        <div>
          <div class="cfg-toggle-label">${label}</div>
          ${options.hint ? `<div class="cfg-toggle-hint">${options.hint}</div>` : ''}
        </div>
        <label class="cfg-toggle">
          <input type="checkbox" id="${id}">
          <span class="cfg-toggle-track"></span>
        </label>
      `;

      const input = row.querySelector('input');
      input.checked = state[key];
      input.onchange = (e) => set(key, e.target.checked);

      currentSection.appendChild(row);
    },

    slider: function (label, key, options = {}) {
      const id = `slider-${key}`;
      defineSetting(key, { id, ...options });

      const row = document.createElement('div');
      row.className = 'cfg-slider-row cfg-3d-row';
      row.innerHTML = `
        <div class="cfg-slider-header">
          <span class="cfg-toggle-label">${label}</span>
          <span class="cfg-slider-value" id="val-${key}">${options.format ? options.format(options.default) : options.default}</span>
        </div>
        <input type="range" class="cfg-slider" id="${id}" 
               min="${options.min ?? 0}" max="${options.max ?? 100}" 
               step="${options.step ?? 1}" value="${options.default ?? 0}">
      `;

      const input = row.querySelector('input');
      input.oninput = (e) => {
        const val = options.step && options.step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value);
        set(key, val);
      };

      currentSection.appendChild(row);
    },

    // Custom dropdown for Resolution
    dropdown: function (label, key, options = {}) {
      const id = `dropdown-${key}`;
      const row = document.createElement('div');
      row.className = 'res-dropdown cfg-3d-row';
      row.id = id;
      row.innerHTML = `
        <div class="cfg-section-label" style="margin-bottom:0;border-bottom:none;padding-bottom:0;">${label}</div>
        <button class="res-dropdown-btn" id="${id}-btn" aria-haspopup="listbox" aria-expanded="false">
          <span id="${id}-label">— select —</span>
          <svg class="res-dropdown-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="#7b8cff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="2,4 6,8 10,4" />
          </svg>
        </button>
        <ul class="res-dropdown-list" id="${id}-list" role="listbox" aria-label="${label}">
        </ul>
      `;
      currentSection.appendChild(row);

      const btn = row.querySelector('.res-dropdown-btn');
      const list = row.querySelector('.res-dropdown-list');
      const labelEl = row.querySelector(`#${id}-label`);

      const LABELS = {
        '960x480': '480p',
        '1280x640': '720p',
        '1920x960': '1080p',
        '2560x1280': '1440p',
        '3840x1920': '4K',
      };

      // Populate list
      Object.entries(LABELS).forEach(([val, text]) => {
        const li = document.createElement('li');
        li.className = 'res-dropdown-item';
        li.dataset.value = val;
        li.innerHTML = `<span class="res-item-label">${text}</span><span class="res-item-sub">${val.replace('x', ' × ')}</span>`;
        li.onclick = () => selectValue(val);
        list.appendChild(li);
      });

      function selectValue(val, skipCallback) {
        labelEl.textContent = LABELS[val] || val;
        list.querySelectorAll('.res-dropdown-item').forEach(el => {
          el.classList.toggle('selected', el.dataset.value === val);
        });
        if (!skipCallback) {
          const [w, h] = val.split('x').map(Number);
          window.__raycaster?.setResolution(w, h);
        }
        list.classList.remove('open');
      }

      btn.onclick = (e) => {
        e.stopPropagation();
        list.classList.toggle('open');
      };

      document.addEventListener('click', () => list.classList.remove('open'));

      window._resDropdown = { selectValue, LABELS, list };
      return row;
    }
  };

  // ── Navigation ────────────────────────────────────────────────────────

  function activateSection(id) {
    sections.forEach(s => {
      const sectEl = document.getElementById(s.id);
      const navEl = document.getElementById(s.navId);
      const active = (s.id === id);
      if (navEl) navEl.classList.toggle('active', active);
      
      if (active && sectEl && content) {
        content.scrollTo({ top: sectEl.offsetTop - 64, behavior: 'smooth' });
      }
    });
  }

  // ── Panel Logic ───────────────────────────────────────────────────────
  let _isOpen = false;
  let _fromGame = false;

  function open(ctx) {
    _fromGame = (ctx !== 'start');
    _isOpen = true;
    titleEl.textContent = _fromGame ? 'PAUSED' : 'SETTINGS';
    resumeBtn.textContent = _fromGame ? 'Resume' : 'Back';
    overlay.classList.add('open');
    if (_fromGame) window.__raycaster?.setPaused(true);

    // Initial sync pass
    for (const key of Object.keys(configs)) _syncDom(key);
    
    // Auto-activate first section
    if (sections.length > 0) activateSection(sections[0].id);
  }

  function close() {
    _isOpen = false;
    overlay.classList.remove('open');
    if (_fromGame) window.__raycaster?.setPaused(false);
  }

  // ── Initialization ────────────────────────────────────────────────────
  window._cfgPanel = { open, close };
  window._settings = { set, get: key => state[key] };
  window._isDevMode = IS_DEV;
  window.UI = UI;

  cfgBtn.addEventListener('click', () => open('game'));
  closeBtn.addEventListener('click', close);
  resumeBtn.addEventListener('click', close);

  // Fullscreen Toggle
  const fsBtn = document.getElementById('fs-btn');
  const fsIcon = document.getElementById('fs-icon');
  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen({ navigationUI: 'hide' })
          .then(() => { screen.orientation?.lock?.('landscape').catch(() => { }); })
          .catch(err => console.warn('Fullscreen failed:', err));
      } else {
        document.exitFullscreen().catch(() => { });
      }
    });

    document.addEventListener('fullscreenchange', () => {
      const active = !!document.fullscreenElement;
      document.body.classList.toggle('is-fullscreen', active);
      fsBtn.classList.toggle('active', active);
    });
  }

  // Parallax Tilt
  const motionOK = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  if (motionOK) {
    panel.addEventListener('mousemove', (e) => {
      if (!_isOpen) return;
      const rect = panel.getBoundingClientRect();
      const dx = e.clientX - (rect.x + rect.width * 0.5);
      const dy = e.clientY - (rect.y + rect.height * 0.5);
      panel.style.setProperty('--x', `${dy / 28}deg`);
      panel.style.setProperty('--y', `${dx / 28}deg`);
    });

    panel.addEventListener('mouseleave', () => {
      panel.style.setProperty('--x', '0deg');
      panel.style.setProperty('--y', '0deg');
    });
  }

  // ── Engine Synchronization ─────────────────────────────────────────────
  
  window._syncAllConfigsToEngine = function () {
    for (const [key, cfg] of Object.entries(configs)) {
      if (cfg.onChange) cfg.onChange(state[key]);
    }
  };

  // Hook for main.js auto-detect



  // Hook for main.js auto-detect

  window._onResDetected = (val) => {
    if (window._resDropdown) {
      window._resDropdown.selectValue(val, true);
      // Add recommended badge
      const item = window._resDropdown.list.querySelector(`[data-value="${val}"]`);
      if (item && !item.querySelector('.res-item-badge')) {
        const badge = document.createElement('span');
        badge.className = 'res-item-badge';
        badge.textContent = 'RECOMMENDED';
        item.appendChild(badge);
        // Refresh label if selected
        window._resDropdown.selectValue(val, true);
      }
    }
  };

})();
