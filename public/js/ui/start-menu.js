/**
 * @file start-menu.js
 * @description Logic for the initial start menu overlay, including play/settings
 *              buttons, roving focus, and mouse/touch parallax effects.
 */

(function () {
  'use strict';

  const startOverlay = document.getElementById('start-overlay');
  const startMenuList = document.getElementById('start-menu-list');
  const playBtn = document.getElementById('start-play-btn');
  const settingsBtn = document.getElementById('start-settings-btn');
  const cfgBtn = document.getElementById('cfg-btn');
  const fsBtn = document.getElementById('fs-btn');

  // Hidden until main.js calls _showStart() after autoDetectResolution.
  if (startOverlay) startOverlay.style.display = 'none';

  // HUD buttons only make sense in-game — hide them until Play is pressed.
  if (cfgBtn) cfgBtn.style.visibility = 'hidden';
  if (fsBtn) fsBtn.style.visibility  = 'hidden';

  if (playBtn) {
    playBtn.addEventListener('click', () => {
      startOverlay.style.display = 'none';
      if (cfgBtn) cfgBtn.style.visibility = '';
      if (fsBtn) fsBtn.style.visibility  = '';
      window.__raycaster?.start();
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      // Open in 'start' context: no pause, title reads "SETTINGS"
      window._cfgPanel?.open('start');
    });
  }

  // ── Arrow-key roving focus ────────────────────────────────────────
  if (startMenuList) {
    startMenuList.addEventListener('keydown', e => {
      const items = [...startMenuList.querySelectorAll('button')];
      const idx   = items.indexOf(document.activeElement);
      if (idx === -1) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        items[(idx + 1) % items.length].focus();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length].focus();
      }
    });

    // ── Menu parallax ─────────────────────────────────────────────────
    const MENU_TILT_SCALE = 20;
    const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const motionOK = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;

    if (motionOK) {
      if (!isTouch) {
        startOverlay.addEventListener('mouseenter', () => {
          startMenuList.style.animationPlayState = 'paused';
        });

        startOverlay.addEventListener('mouseleave', () => {
          startMenuList.style.animationPlayState = '';
          startMenuList.style.removeProperty('--x');
          startMenuList.style.removeProperty('--y');
        });

        startOverlay.addEventListener('mousemove', ({clientX, clientY}) => {
          const rect = startMenuList.getBoundingClientRect();
          if (!rect.width) return;
          const dx = clientX - (rect.x + rect.width  * 0.5);
          const dy = clientY - (rect.y + rect.height * 0.5);
          startMenuList.style.setProperty('--x', `${dy  / MENU_TILT_SCALE}deg`);
          startMenuList.style.setProperty('--y', `${dx  / MENU_TILT_SCALE}deg`);
        });
      } else {
        function applyMenuTilt(touch) {
          const rect = startMenuList.getBoundingClientRect();
          if (!rect.width) return;
          const dx = touch.clientX - (rect.x + rect.width  * 0.5);
          const dy = touch.clientY - (rect.y + rect.height * 0.5);
          startMenuList.style.setProperty('--x', `${-(dy / MENU_TILT_SCALE)}deg`);
          startMenuList.style.setProperty('--y', `${-(dx / MENU_TILT_SCALE)}deg`);
        }

        startOverlay.addEventListener('touchstart', e => {
          startMenuList.style.animationPlayState = 'paused';
          applyMenuTilt(e.touches[0]);
        }, {passive: true});

        startOverlay.addEventListener('touchend', () => {
          startMenuList.style.animationPlayState = '';
        });

        startOverlay.addEventListener('touchmove', e => {
          applyMenuTilt(e.touches[0]);
        }, {passive: true});
      }
    }
  }

  window._showStart = function () {
    // Sync all default UI states down to the engine now that it is ready.
    // We expect window.UI configs and state to be exposed or managed differently,
    // but the actual settings engine lives in ui.js. 
    // We must ensure the `_syncConfigToEngine` callback is available or we trigger it.
    if (window._syncAllConfigsToEngine) {
      window._syncAllConfigsToEngine();
    }

    if (startOverlay) {
      startOverlay.style.display = '';
      if (startMenuList) {
        startMenuList.style.removeProperty('--x');
        startMenuList.style.removeProperty('--y');
      }
      setTimeout(() => {
        startOverlay.classList.add('is-open');
        if (playBtn) playBtn.focus();
      }, 10);
    }
  };

})();
