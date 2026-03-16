/**
 * @fileoverview Mobile device support: detection, keyboard handling, and swipe navigation.
 *
 * Defines three singleton objects that manage mobile-specific behavior:
 *
 * - MobileDetection — Device type detection (mobile/tablet/desktop), touch capability,
 *   iOS/Safari identification, and body class management for CSS targeting.
 * - KeyboardHandler — Virtual keyboard show/hide detection via visualViewport API,
 *   toolbar/accessory bar repositioning, terminal resize on keyboard open/close,
 *   and input scroll-into-view. Uses 100px threshold for iOS address bar drift.
 * - SwipeHandler — Horizontal swipe detection on the terminal area for session switching.
 *   80px minimum distance, 300ms maximum time, 100px max vertical drift.
 *
 * All three have init()/cleanup() lifecycle methods. They are re-initialized after SSE
 * reconnect (in handleInit) to prevent stale closures.
 *
 * @globals {object} MobileDetection
 * @globals {object} KeyboardHandler
 * @globals {object} SwipeHandler
 *
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar reference in KeyboardHandler.onKeyboardShow, soft — guarded with typeof check)
 * @loadorder 2 of 9 — loaded after constants.js, before voice-input.js
 */

// Codeman — Mobile detection, keyboard handling, and swipe navigation
// Loaded after constants.js, before app.js

// ═══════════════════════════════════════════════════════════════
// Mobile Detection
// ═══════════════════════════════════════════════════════════════

/**
 * MobileDetection - Detects device type and touch capability.
 * Updates body classes for CSS targeting.
 */
const MobileDetection = {
  /** Check if device supports touch input */
  isTouchDevice() {
    return 'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  },

  /** Check if device is iOS (iPhone, iPad, iPod) */
  isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  /** Check if browser is Safari */
  isSafari() {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  },

  /** Check if screen is small (phone-sized, <430px) */
  isSmallScreen() {
    return window.innerWidth < 430;
  },

  /** Check if screen is medium (tablet-sized, 430-768px) */
  isMediumScreen() {
    return window.innerWidth >= 430 && window.innerWidth < 768;
  },

  /** Get device type based on screen width */
  getDeviceType() {
    const width = window.innerWidth;
    if (width < 430) return 'mobile';
    if (width < 768) return 'tablet';
    return 'desktop';
  },

  /** Update body classes based on device detection */
  updateBodyClass() {
    const body = document.body;
    const deviceType = this.getDeviceType();
    const isTouch = this.isTouchDevice();

    // Remove existing device classes
    body.classList.remove('device-mobile', 'device-tablet', 'device-desktop', 'touch-device', 'ios-device', 'safari-browser');

    // Add current device class
    body.classList.add(`device-${deviceType}`);

    // Add touch device class if applicable
    if (isTouch) {
      body.classList.add('touch-device');
    }

    // Add iOS-specific class for safe area handling
    if (this.isIOS()) {
      body.classList.add('ios-device');
    }

    // Add Safari class for browser-specific fixes
    if (this.isSafari()) {
      body.classList.add('safari-browser');
    }
  },

  /** Initialize mobile detection and set up resize listener */
  init() {
    this.updateBodyClass();
    // Debounced resize handler
    let resizeTimeout;
    this._resizeHandler = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.updateBodyClass(), 100);
    };
    window.addEventListener('resize', this._resizeHandler);

    // iOS: prevent pinch-to-zoom (Safari ignores user-scalable=no since iOS 10)
    if (this.isIOS()) {
      this._gestureStartHandler = (e) => e.preventDefault();
      this._gestureChangeHandler = (e) => e.preventDefault();
      document.addEventListener('gesturestart', this._gestureStartHandler);
      document.addEventListener('gesturechange', this._gestureChangeHandler);
    }
  },

  /** Remove event listeners */
  cleanup() {
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._gestureStartHandler) {
      document.removeEventListener('gesturestart', this._gestureStartHandler);
      document.removeEventListener('gesturechange', this._gestureChangeHandler);
      this._gestureStartHandler = null;
      this._gestureChangeHandler = null;
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// Mobile Keyboard Handler
// ═══════════════════════════════════════════════════════════════

/**
 * KeyboardHandler - Simple handler to scroll inputs into view when keyboard appears.
 * Uses focusin event and scrollIntoView - keeps it simple and reliable.
 * Also handles terminal scrolling and toolbar repositioning via visualViewport API.
 */
const KeyboardHandler = {
  lastViewportHeight: 0,
  keyboardVisible: false,
  initialViewportHeight: 0,

  /** Initialize keyboard handling */
  init() {
    // Only initialize on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    this.initialViewportHeight = window.visualViewport?.height || window.innerHeight;
    this.lastViewportHeight = this.initialViewportHeight;

    // Cache safe-area-bottom once (env(safe-area-inset-bottom)) — varies per device.
    // Used in all layout padding calculations to account for home indicator / gesture bar.
    this.safeAreaBottom = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--safe-area-bottom')
    ) || 0;

    // Simple focus handler - scroll input into view after keyboard appears
    this._focusinHandler = (e) => {
      const target = e.target;
      if (!this.isInputElement(target)) return;

      // Wait for keyboard animation, then scroll input into view
      setTimeout(() => {
        this.scrollInputIntoView(target);
      }, 400);
    };
    document.addEventListener('focusin', this._focusinHandler);

    // Use visualViewport to detect keyboard and reposition toolbar
    if (window.visualViewport) {
      this._viewportResizeHandler = () => {
        this.handleViewportResize();
      };
      this._viewportScrollHandler = () => {
        this.updateLayoutForKeyboard();
      };
      window.visualViewport.addEventListener('resize', this._viewportResizeHandler);
      // Also handle scroll (iOS scrolls viewport when keyboard appears)
      window.visualViewport.addEventListener('scroll', this._viewportScrollHandler);
    }
  },

  /** Remove event listeners */
  cleanup() {
    if (this._focusinHandler) {
      document.removeEventListener('focusin', this._focusinHandler);
      this._focusinHandler = null;
    }
    if (this._viewportResizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._viewportResizeHandler);
      this._viewportResizeHandler = null;
    }
    if (this._viewportScrollHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('scroll', this._viewportScrollHandler);
      this._viewportScrollHandler = null;
    }
  },

  /** Handle viewport resize (keyboard show/hide) */
  handleViewportResize() {
    const currentHeight = window.visualViewport?.height || window.innerHeight;
    const heightDiff = this.initialViewportHeight - currentHeight;

    // Keyboard appeared (viewport shrunk by more than 150px)
    if (heightDiff > 150 && !this.keyboardVisible) {
      this.keyboardVisible = true;
      document.body.classList.add('keyboard-visible');
      this.onKeyboardShow();
    }
    // Keyboard hidden (viewport grew back close to initial)
    // Use 100px threshold (not 50) to handle iOS address bar drift,
    // iOS 26's persistent 24px discrepancy, and Safari bottom bar changes
    else if (heightDiff < 100 && this.keyboardVisible) {
      this.keyboardVisible = false;
      document.body.classList.remove('keyboard-visible');
      this.onKeyboardHide();
    }

    // Update baseline when keyboard is not visible — adapts to address bar
    // state changes, orientation changes, and other viewport shifts
    if (!this.keyboardVisible) {
      this.initialViewportHeight = currentHeight;
    }

    this.updateLayoutForKeyboard();
    this.lastViewportHeight = currentHeight;
  },

  /** Update layout when keyboard shows/hides */
  updateLayoutForKeyboard() {
    if (!window.visualViewport) return;

    // Only adjust on mobile
    if (!MobileDetection.isSmallScreen() && !MobileDetection.isMediumScreen()) {
      this.resetLayout();
      return;
    }

    const toolbar = document.querySelector('.toolbar');
    const accessoryBar = document.querySelector('.keyboard-accessory-bar');
    const main = document.querySelector('.main');

    if (this.keyboardVisible) {
      // Calculate keyboard offset
      const layoutHeight = window.innerHeight;
      const visualBottom = window.visualViewport.offsetTop + window.visualViewport.height;
      let keyboardOffset = layoutHeight - visualBottom;

      if (keyboardOffset <= 0) {
        const viewportShrinkage = this.initialViewportHeight - window.innerHeight;
        if (viewportShrinkage > 100) {
          // Android resize mode: browser already shrank innerHeight to exclude keyboard.
          // Fixed elements auto-position at bottom of visible area — no transforms needed.
          // Only reserve space for the fixed bars; do NOT add keyboard height again.
          if (toolbar) toolbar.style.transform = '';
          if (accessoryBar) accessoryBar.style.transform = '';
          const inputPanel = document.getElementById('mobileInputPanel');
          if (inputPanel) inputPanel.style.transform = '';
          if (main) {
            // With resizes-content, innerHeight is already the visible area.
            // Just reserve space for the fixed bars + safe-area-bottom.
            const barHeight = accessoryBar?.classList.contains('visible') ? 132 : 40;
            main.style.paddingBottom = `${barHeight + this.safeAreaBottom}px`;
          }
          return;
        } else {
          // iOS: keyboard-visible flag is stale, keyboard is actually gone.
          this.keyboardVisible = false;
          document.body.classList.remove('keyboard-visible');
          this.onKeyboardHide();
          return;
        }
      }

      // iOS / Android pan mode: translate bars up above keyboard.
      if (toolbar) toolbar.style.transform = `translateY(${-keyboardOffset}px)`;
      if (accessoryBar) accessoryBar.style.transform = `translateY(${-keyboardOffset}px)`;
      const inputPanel = document.getElementById('mobileInputPanel');
      if (inputPanel) inputPanel.style.transform = `translateY(${-keyboardOffset}px)`;

      // Reserve space for keyboard + translated bars + safe-area-bottom.
      if (main) {
        const barHeight = accessoryBar?.classList.contains('visible') ? 132 : 40;
        main.style.paddingBottom = `${keyboardOffset + barHeight + this.safeAreaBottom}px`;
      }
    } else {
      this.resetLayout();
    }
  },

  /** Reset layout to normal (no keyboard) */
  resetLayout() {
    const toolbar = document.querySelector('.toolbar');
    const accessoryBar = document.querySelector('.keyboard-accessory-bar');
    const main = document.querySelector('.main');

    if (toolbar) toolbar.style.transform = '';
    if (accessoryBar) accessoryBar.style.transform = '';
    const inputPanel = document.getElementById('mobileInputPanel');
    if (inputPanel) inputPanel.style.transform = '';

    if (main) {
      const barHeight = accessoryBar?.classList.contains('visible') ? 132 : 40;
      main.style.paddingBottom = `${barHeight + this.safeAreaBottom}px`;
    }
  },

  /** Called when keyboard appears */
  onKeyboardShow() {
    // Bar is already visible (always-on); nothing to show here.

    // Refit terminal locally AND send resize to server so Claude Code (Ink)
    // knows the actual terminal dimensions. Without this, Ink redraws at the
    // old (larger) row count when the user types, causing content to scroll
    // off the visible area with each keystroke.
    // Note: the throttledResize handler still suppresses ongoing resize events
    // while keyboard is up — this one-shot resize on open/close is sufficient.
    setTimeout(() => {
      if (typeof app !== 'undefined' && app.terminal) {
        if (app.fitAddon) try { app.fitAddon.fit(); } catch {}
        app.terminal.scrollToBottom();
        // Send resize to server so PTY dimensions match xterm
        this._sendTerminalResize();
      }
    }, 150);

    // Reposition subagent windows to stack from bottom (above keyboard)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /** Called when keyboard hides */
  onKeyboardHide() {
    // Keep accessory bar visible — tapping any button on Android dismisses the
    // keyboard, so hiding the bar on keyboard-hide makes every button destroy itself.

    // Capture scroll state BEFORE layout changes so we can restore it after fitAddon.fit()
    const terminal = typeof app !== 'undefined' ? app.terminal : null;
    const wasAtBottom = typeof app !== 'undefined' && typeof app.isTerminalAtBottom === 'function'
      ? app.isTerminalAtBottom()
      : true;
    const preViewportY = terminal?.buffer?.active?.viewportY;
    const preBaseY     = terminal?.buffer?.active?.baseY;

    this.resetLayout();

    // Refit terminal and restore scroll position, then send resize to restore original dimensions
    setTimeout(() => {
      if (typeof app !== 'undefined' && app.fitAddon) {
        try { app.fitAddon.fit(); } catch {}

        if (app.terminal) {
          if (wasAtBottom) {
            // Was at bottom — stay at bottom after resize
            app.terminal.scrollToBottom();
          } else if (preViewportY !== undefined && preBaseY !== undefined) {
            // Was scrolled up — restore relative position from scrollback start
            const offsetFromBase = preViewportY - preBaseY;
            const newBase = app.terminal.buffer.active.baseY;
            app.terminal.scrollToLine(newBase + Math.max(0, offsetFromBase));
          }
        }
        // Send resize to server to restore full terminal size
        this._sendTerminalResize();
      }
    }, 100);

    // Reposition subagent windows to stack from top (below header)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /** Send current terminal dimensions to the server (one-shot, for keyboard open/close) */
  _sendTerminalResize() {
    if (typeof app === 'undefined' || !app.activeSessionId || !app.fitAddon) return;
    // Don't resize during tab switch buffer load — selectSession calls sendResize at the end,
    // and an early resize causes Ink to redraw, queueing a full-screen repaint in
    // _loadBufferQueue that flushes on top of the loaded buffer (looks like reload).
    if (app._isLoadingBuffer) return;
    try {
      const dims = app.fitAddon.proposeDimensions();
      if (dims) {
        const cols = Math.max(dims.cols, 40);
        const rows = Math.max(dims.rows, 10);
        app._lastResizeDims = { cols, rows };
        fetch(`/api/sessions/${app.activeSessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols, rows })
        }).catch(() => {});
      }
    } catch {}
  },

  /** Check if element is an input that triggers keyboard (excludes terminal) */
  isInputElement(el) {
    if (!el) return false;

    // Exclude xterm.js terminal inputs (they handle their own scroll)
    if (el.closest('.xterm') || el.closest('.terminal-container')) {
      return false;
    }

    const tagName = el.tagName?.toLowerCase();
    // Exclude type=range, type=checkbox, type=radio (don't trigger keyboard)
    if (tagName === 'input') {
      const type = el.type?.toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'range' || type === 'file') {
        return false;
      }
    }
    return (
      tagName === 'input' ||
      tagName === 'textarea' ||
      el.isContentEditable
    );
  },

  /** Scroll input into view above the keyboard */
  scrollInputIntoView(input) {
    // Check if input is still focused (user might have tapped away)
    if (document.activeElement !== input) return;

    // Find if we're in a modal
    const modal = input.closest('.modal.active');
    const modalBody = modal?.querySelector('.modal-body');

    if (modalBody) {
      // For modals - scroll within the modal body
      const inputRect = input.getBoundingClientRect();
      const modalRect = modalBody.getBoundingClientRect();

      // If input is below middle of modal, scroll it up
      if (inputRect.top > modalRect.top + modalRect.height * 0.4) {
        const scrollAmount = inputRect.top - modalRect.top - 100;
        modalBody.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
    } else {
      // For page-level - use scrollIntoView
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// Mobile Swipe Handler
// ═══════════════════════════════════════════════════════════════

/**
 * SwipeHandler - Animated horizontal swipe gesture to switch sessions on mobile.
 *
 * Uses a CSS-transform slide animation on .main plus a skeleton overlay for the
 * incoming session. The actual selectSession() call happens after the transition
 * completes, so the UI never shows a blank screen mid-animation.
 *
 * Gesture logic:
 * - Tracks touchstart/touchmove/touchend on .main
 * - Disambiguates horizontal vs vertical after LOCK_THRESHOLD px of movement
 * - Commits to switch if swipe > 30% of screen width OR velocity > 0.4px/ms (fling)
 * - Cancels (springs back) if threshold not met
 * - All disable conditions checked at touchstart
 *
 * Only active on touch devices. Guards with MobileDetection.isTouchDevice() and
 * MobileDetection.getDeviceType() === 'mobile'.
 */
const SwipeHandler = {
  // Touch tracking state
  startX: 0,
  startY: 0,
  startTime: 0,
  _deltaX: 0,

  // Gesture state
  _locked: false,       // true once gesture is locked as horizontal
  _cancelled: false,    // true once gesture is locked as vertical (cancel)
  _animating: false,    // true during commit/cancel transition
  _targetId: null,      // session ID we are swiping toward
  _direction: 0,        // +1 = swiping right (prev), -1 = swiping left (next)
  _skeleton: null,      // skeleton DOM element

  // Config
  COMMIT_RATIO: 0.30,   // 30% of screen width
  FLING_VELOCITY: 0.4,  // px/ms — fling threshold
  LOCK_THRESHOLD: 10,   // px before locking gesture direction
  TRANSITION_MS: 250,   // animation duration

  // Listener refs
  _touchStartHandler: null,
  _touchMoveHandler: null,
  _touchEndHandler: null,
  _element: null,

  /** Initialize swipe handling */
  init() {
    if (!MobileDetection.isTouchDevice()) return;

    const el = document.querySelector('.main');
    if (!el) return;

    this._element = el;
    this._touchStartHandler = (e) => this._onTouchStart(e);
    this._touchMoveHandler  = (e) => this._onTouchMove(e);
    this._touchEndHandler   = (e) => this._onTouchEnd(e);

    el.addEventListener('touchstart',  this._touchStartHandler, { passive: true });
    // touchmove must be non-passive so we can preventDefault for horizontal lock
    el.addEventListener('touchmove',   this._touchMoveHandler,  { passive: false });
    el.addEventListener('touchend',    this._touchEndHandler,   { passive: true });
    el.addEventListener('touchcancel', this._touchEndHandler,   { passive: true });
  },

  /** Remove swipe listeners */
  cleanup() {
    if (this._element) {
      if (this._touchStartHandler) this._element.removeEventListener('touchstart',  this._touchStartHandler);
      if (this._touchMoveHandler)  this._element.removeEventListener('touchmove',   this._touchMoveHandler);
      if (this._touchEndHandler) {
        this._element.removeEventListener('touchend',   this._touchEndHandler);
        this._element.removeEventListener('touchcancel',this._touchEndHandler);
      }
    }
    this._touchStartHandler = null;
    this._touchMoveHandler  = null;
    this._touchEndHandler   = null;
    this._element           = null;
    this._skeleton          = null;
    this._animating         = false;
    this._locked            = false;
    this._cancelled         = false;
    this._targetId          = null;
  },

  /** Check whether swipe gestures are currently permitted */
  _isDisabled() {
    if (!MobileDetection.isTouchDevice()) return true;
    if (this._animating) return true;
    if (typeof app === 'undefined') return true;
    if (!app.sessionOrder || app.sessionOrder.length <= 1) return true;
    if (app._isLoadingBuffer) return true;
    if (typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible) return true;
    if (document.getElementById('sessionDrawer') && document.getElementById('sessionDrawer').classList.contains('open')) return true;
    if (document.querySelector('.modal.active')) return true;
    if (typeof McpPanel !== 'undefined' && McpPanel._panel?.classList.contains('open')) return true;
    if (typeof PluginsPanel !== 'undefined' && PluginsPanel._panel?.classList.contains('open')) return true;
    if (typeof ContextBar !== 'undefined' && ContextBar._panel?.classList.contains('open')) return true;
    if (typeof InputPanel !== 'undefined' && InputPanel._open && KeyboardHandler.keyboardVisible) return true;
    const auqPanel = document.getElementById('askUserQuestionPanel');
    if (auqPanel && auqPanel.style.display !== 'none') return true;
    return false;
  },

  _onTouchStart(e) {
    if (this._isDisabled()) return;
    if (!e.touches || e.touches.length !== 1) return;

    this.startX    = e.touches[0].clientX;
    this.startY    = e.touches[0].clientY;
    this.startTime = Date.now();
    this._deltaX   = 0;
    this._locked   = false;
    this._cancelled= false;
    this._targetId = null;
    this._direction= 0;
  },

  _onTouchMove(e) {
    if (this._animating || this._cancelled) return;
    if (!e.touches || e.touches.length !== 1) return;
    if (!this._locked && this._isDisabled()) return;

    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    const dx = x - this.startX;
    const dy = y - this.startY;
    this._deltaX = dx;

    if (!this._locked) {
      // Wait for enough movement before locking direction
      if (Math.abs(dx) < this.LOCK_THRESHOLD && Math.abs(dy) < this.LOCK_THRESHOLD) return;

      if (Math.abs(dy) > Math.abs(dx)) {
        // Vertical gesture — let browser handle scrolling
        this._cancelled = true;
        return;
      }

      // Horizontal gesture — lock in
      this._locked    = true;
      this._direction = dx > 0 ? 1 : -1;  // +1 = prev, -1 = next

      // Resolve target session
      this._targetId = this._resolveTarget(this._direction);
      if (!this._targetId) {
        this._cancelled = true;
        return;
      }

      // Create skeleton overlay
      this._skeleton = this._createSkeleton(this._targetId, this._direction);
      if (this._element) this._element.appendChild(this._skeleton);
    }

    // Prevent page scroll while handling horizontal swipe
    e.preventDefault();

    // Move .main; skeleton position follows as it is a child with its own constant offset
    if (this._element) {
      this._element.style.transform = 'translateX(' + dx + 'px)';
    }
  },

  _onTouchEnd(e) {
    if (this._animating) return;
    if (this._cancelled || !this._locked) {
      // Nothing was locked — clean up any stale transform
      if (this._element) this._element.style.transform = '';
      this._cleanup();
      return;
    }

    const elapsed = Date.now() - this.startTime;
    const dx = this._deltaX;
    const velocity = elapsed > 0 ? Math.abs(dx) / elapsed : 0;
    const threshold = window.innerWidth * this.COMMIT_RATIO;
    const shouldCommit = Math.abs(dx) >= threshold || velocity >= this.FLING_VELOCITY;

    // Ensure direction still matches final delta (user may have reversed)
    const finalDirection = dx > 0 ? 1 : -1;
    if (finalDirection !== this._direction) {
      this._springBack();
      return;
    }

    if (shouldCommit) {
      this._commitSwipe();
    } else {
      this._springBack();
    }
  },

  /** Resolve the session ID in the given direction (+1 = prev, -1 = next) */
  _resolveTarget(direction) {
    if (typeof app === 'undefined' || !app.sessionOrder) return null;
    // Use the drawer's visual order so swipe navigation matches the session list in the hamburger menu
    const order = (typeof SessionDrawer !== 'undefined' && SessionDrawer._getOrderedSessionIds)
      ? SessionDrawer._getOrderedSessionIds()
      : app.sessionOrder;
    const idx = order.indexOf(app.activeSessionId);
    if (idx < 0) return null;
    if (direction === 1) {
      const prevIdx = (idx - 1 + order.length) % order.length;
      return prevIdx !== idx ? order[prevIdx] : null;
    } else {
      const nextIdx = (idx + 1) % order.length;
      return nextIdx !== idx ? order[nextIdx] : null;
    }
  },

  /** Build a skeleton overlay for the incoming session using safe DOM methods */
  _createSkeleton(sessionId, direction) {
    const vw = window.innerWidth;
    // Start position: off-screen left (-vw) for prev (swipe right), off-screen right (+vw) for next (swipe left)
    const offsetX = direction === 1 ? -vw : vw;

    // Get session name for the pill label (textContent is XSS-safe)
    let label = sessionId ? sessionId.slice(0, 6) : '...';
    if (typeof app !== 'undefined' && app.sessions) {
      const s = app.sessions.get(sessionId);
      if (s && s.name) label = s.name;
    }

    const el = document.createElement('div');
    el.className = 'swipe-session-skeleton';
    // The skeleton is a child of .main which is being translated.
    // Its own translateX is a constant offset so it stays one viewport-width away.
    el.style.transform = 'translateX(' + offsetX + 'px)';

    const pill = document.createElement('div');
    pill.className = 'skeleton-session-pill';
    pill.textContent = label;
    el.appendChild(pill);

    const lines = document.createElement('div');
    lines.className = 'skeleton-lines';
    ['', 'short', '', 'short'].forEach(function(cls) {
      const line = document.createElement('div');
      line.className = cls ? 'skeleton-line ' + cls : 'skeleton-line';
      lines.appendChild(line);
    });
    el.appendChild(lines);

    return el;
  },

  /** Animate commit: slide .main off-screen, then call selectSession */
  _commitSwipe() {
    if (!this._element || !this._targetId) { this._springBack(); return; }
    this._animating = true;

    const targetX = this._direction === 1 ? window.innerWidth : -window.innerWidth;
    const self = this;

    this._element.classList.add('swipe-transitioning');
    this._element.style.transform = 'translateX(' + targetX + 'px)';

    const onDone = function() {
      self._element.removeEventListener('transitionend', onDone);
      self._element.classList.remove('swipe-transitioning');
      self._element.style.transform = '';
      const targetId = self._targetId;
      self._cleanup();
      // Switch session after animation frame so transform reset renders first
      requestAnimationFrame(function() {
        if (typeof app !== 'undefined' && targetId) app.selectSession(targetId);
      });
    };
    this._element.addEventListener('transitionend', onDone, { once: true });

    // Safety timeout in case transitionend does not fire
    setTimeout(function() {
      if (self._animating) onDone();
    }, this.TRANSITION_MS + 100);
  },

  /** Animate cancel: spring .main back to origin */
  _springBack() {
    if (!this._element) { this._cleanup(); return; }
    this._animating = true;
    const self = this;

    this._element.classList.add('swipe-transitioning');
    this._element.style.transform = '';

    const onDone = function() {
      self._element.removeEventListener('transitionend', onDone);
      self._element.classList.remove('swipe-transitioning');
      self._cleanup();
    };
    this._element.addEventListener('transitionend', onDone, { once: true });

    setTimeout(function() {
      if (self._animating) onDone();
    }, this.TRANSITION_MS + 100);
  },

  /** Remove skeleton and reset gesture state */
  _cleanup() {
    if (this._skeleton && this._skeleton.parentNode) {
      this._skeleton.parentNode.removeChild(this._skeleton);
    }
    this._skeleton  = null;
    this._locked    = false;
    this._cancelled = false;
    this._animating = false;
    this._targetId  = null;
    this._direction = 0;
    this._deltaX    = 0;
  },
};
