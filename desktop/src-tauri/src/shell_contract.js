// Ashlr desktop shell contract — injected into the Verse page before any page
// script runs, on the sidecar origin only.
//
// This file is the *whole* native→web surface of the desktop app. It is
// documented for the web UI in desktop/README.md ("Desktop shell contract").
// It deliberately does not expose Tauri's IPC to page code.
;(function () {
  var cfg = __ASHLR_SHELL_CONFIG

  // Hard origin gate: the CSP already forbids other origins, but the script
  // runs on every navigation in this webview, so it re-checks itself.
  if (window.location.origin !== cfg.origin) return

  // 1. Tokens ---------------------------------------------------------------
  // Present only once the sidecar has reported readiness. SessionGate reads
  // this and skips the paste prompt.
  if (cfg.tokens) {
    try {
      window.__ASHLR_TOKENS__ = Object.freeze(cfg.tokens)
    } catch (_) {}
  }

  var root = document.documentElement
  if (!root) return

  // 2. Shell markers --------------------------------------------------------
  // The web UI keys its desktop-only chrome off these. In a browser they are
  // simply absent and every default below falls back to 0.
  root.setAttribute('data-app-shell', 'desktop')
  root.setAttribute('data-app-platform', cfg.platform)
  root.style.setProperty('--app-titlebar-height', cfg.titlebarHeight + 'px')
  root.style.setProperty('--app-traffic-light-inset', cfg.trafficLightInset + 'px')

  function invoke(command, args) {
    var internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return
    try {
      internals.invoke(command, args)
    } catch (_) {}
  }

  var lastTheme = null

  // Desktop state (Settings ▸ Desktop): the global hotkey and notifications.
  // Native owns it; the page reads a copy and asks for changes.
  var desktopState = cfg.desktop || null
  var updateState = null
  function copyUpdateState() {
    try { return updateState ? JSON.parse(JSON.stringify(updateState)) : null } catch (_) { return null }
  }

  function copyState() {
    if (!desktopState) return null
    try {
      return JSON.parse(JSON.stringify(desktopState))
    } catch (_) {
      return null
    }
  }

  // Integrated browser (protocol v1, browser_pane.rs). The page hands native a
  // plain-object message; native parses it strictly (unknown ops or fields are
  // dropped) and answers through window.__ASHLR_BROWSER_EVENT__ below.
  var BROWSER_MESSAGE_MAX = 16384

  function sendBrowser(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false
    var proto = Object.getPrototypeOf(msg)
    if (proto !== Object.prototype && proto !== null) return false
    var json
    try {
      json = JSON.stringify(msg)
    } catch (_) {
      return false
    }
    if (typeof json !== 'string' || json.length > BROWSER_MESSAGE_MAX) return false
    var internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return false
    try {
      var pending = internals.invoke('plugin:event|emit', {
        event: 'shell-browser',
        payload: JSON.parse(json)
      })
      if (pending && typeof pending.catch === 'function') pending.catch(function () {})
    } catch (_) {
      return false
    }
    return true
  }

  // Dictation (protocol v1, voice/mod.rs). Same rules as the browser channel:
  // plain objects only, JSON round-tripped, size-capped; native parses the
  // op strictly (voice/protocol.rs) and answers through
  // window.__ASHLR_VOICE_EVENT__ below.
  var VOICE_MESSAGE_MAX = 8192

  function sendVoice(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false
    var proto = Object.getPrototypeOf(msg)
    if (proto !== Object.prototype && proto !== null) return false
    var json
    try {
      json = JSON.stringify(msg)
    } catch (_) {
      return false
    }
    if (typeof json !== 'string' || json.length > VOICE_MESSAGE_MAX) return false
    var internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return false
    try {
      var pending = internals.invoke('plugin:event|emit', {
        event: 'shell-voice',
        payload: JSON.parse(json)
      })
      if (pending && typeof pending.catch === 'function') pending.catch(function () {})
    } catch (_) {
      return false
    }
    return true
  }

  // Fleet operations (protocol v1, fleet_ops.rs): resident start / restart /
  // stop and the custody install, with no Terminal. The page names an op;
  // native parses it strictly, confirms every raise in a NATIVE dialog the
  // page cannot answer, and reports through window.__ASHLR_FLEET_EVENT__.
  var FLEET_OPS = { 'resident-start': 1, 'resident-restart': 1, 'resident-stop': 1, 'custody-install': 1 }

  function sendFleet(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false
    if (typeof msg.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(msg.id)) return false
    if (typeof msg.op !== 'string' || !Object.prototype.hasOwnProperty.call(FLEET_OPS, msg.op)) return false
    var payload = { id: msg.id, op: msg.op }
    if (msg.op === 'custody-install') {
      if (typeof msg.checkout !== 'string' || msg.checkout.length === 0 || msg.checkout.length > 1024) return false
      payload.checkout = msg.checkout
    }
    var internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return false
    try {
      var pending = internals.invoke('plugin:event|emit', { event: 'shell-fleet', payload: payload })
      if (pending && typeof pending.catch === 'function') pending.catch(function () {})
    } catch (_) {
      return false
    }
    return true
  }

  // Computer use (protocol v1, computer.rs). Same shape as the browser
  // channel: a plain object, measured and sent as a JSON round-trip copy.
  // Native is the enforcement point (denylist, tier ceilings, secure fields,
  // takeover, kill switch) and answers through window.__ASHLR_COMPUTER_EVENT__.
  var COMPUTER_MESSAGE_MAX = 16384

  function sendComputer(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false
    var proto = Object.getPrototypeOf(msg)
    if (proto !== Object.prototype && proto !== null) return false
    var json
    try {
      json = JSON.stringify(msg)
    } catch (_) {
      return false
    }
    if (typeof json !== 'string' || json.length > COMPUTER_MESSAGE_MAX) return false
    var internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return false
    try {
      var pending = internals.invoke('plugin:event|emit', {
        event: 'shell-computer',
        payload: JSON.parse(json)
      })
      if (pending && typeof pending.catch === 'function') pending.catch(function () {})
    } catch (_) {
      return false
    }
    return true
  }

  window.__ASHLR_DESKTOP__ = Object.freeze({
    shell: 'tauri',
    platform: cfg.platform,
    version: cfg.version,
    titlebarHeight: cfg.titlebarHeight,
    trafficLightInset: cfg.trafficLightInset,
    // Tell the native window which theme the UI settled on, so the window
    // background matches on the NEXT launch and dark mode never flashes white.
    // Safe to call on every theme change; repeats are dropped here.
    reportTheme: function (theme) {
      var next = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : null
      if (!next || next === lastTheme) return
      lastTheme = next
      invoke('plugin:event|emit', { event: 'shell-theme', payload: next })
    },
    // The current desktop state, or null before native has sent one. A copy:
    // page code cannot edit what native believes.
    getState: copyState,
    // Refresh only: native reads authenticated activity; the page supplies no counts.
    refreshState: function () {
      invoke('plugin:event|emit', { event: 'shell-state-request', payload: null })
      return true
    },
    // Ask native to change a preference. Only known names, booleans
    // only; native re-validates and answers with an `ashlr:desktop-state`
    // event carrying what actually happened (a hotkey another app holds comes
    // back enabled-but-unregistered, with a reason).
    setPreference: function (name, value) {
      if (name !== 'globalHotkey' && name !== 'notifications' && name !== 'automaticAwake' && name !== 'automaticUpdates') return false
      if (typeof value !== 'boolean') return false
      var patch = {}
      patch[name] = value
      invoke('plugin:event|emit', { event: 'shell-prefs', payload: patch })
      return true
    },
    // Integrated browser pane. Absent on older shells: that absence is the
    // feature test (the web UI then falls back to an <iframe>). `act` (the
    // pane can click and type — macOS) is feature-detected; the protocol
    // version does not change.
    updates: Object.freeze({
      getState: copyUpdateState,
      refresh: function () {
        invoke('plugin:event|emit', { event: 'shell-update', payload: { op: 'status' } })
        return true
      }
    }),
    browser: Object.freeze({
      version: 1,
      capabilities: Object.freeze({
        screenshot: cfg.browserScreenshot === true,
        act: cfg.browserAct === true,
        picker: true,
        console: true,
        text: true
      }),
      send: sendBrowser
    }),
    // Dictation: capture + transcription run natively (the WKWebView has no
    // Web Speech API). Absent on older shells — that absence is the web UI's
    // feature test, exactly like `browser`.
    voice: Object.freeze({
      version: 1,
      send: sendVoice
    }),
    // Fleet operations. Absent on older shells: that absence is the feature
    // test (the Fleet tab then shows the Terminal command instead).
    fleet: Object.freeze({
      version: 1,
      ops: Object.freeze(Object.keys(FLEET_OPS)),
      send: sendFleet
    }),
    // Desktop control for Verse's agents. Absent on older shells (the
    // feature test); `supported` is false off macOS, where every op answers
    // `unsupported`.
    computer: Object.freeze({
      version: 1,
      capabilities: Object.freeze({ supported: cfg.computerSupported === true }),
      send: sendComputer
    })
  })

  // Native → page: browser pane events (browser_pane::event_script). Defined
  // non-writable and non-configurable so page code can neither replace nor
  // wrap the channel. Re-running this script on the same page (tokens handed
  // over late) throws here, harmlessly: the first definition stands.
  try {
    Object.defineProperty(window, '__ASHLR_BROWSER_EVENT__', {
      value: function (detail) {
        if (!detail || typeof detail !== 'object') return
        try {
          window.dispatchEvent(new CustomEvent('ashlr:browser', { detail: detail }))
        } catch (_) {}
      },
      enumerable: false,
      writable: false,
      configurable: false
    })
  } catch (_) {}

  // Native → page: dictation events (voice/protocol.rs event_script) —
  // voice://state | level | partial | final | error. Locked like the browser
  // channel so page code cannot intercept a transcript.
  try {
    Object.defineProperty(window, '__ASHLR_VOICE_EVENT__', {
      value: function (detail) {
        if (!detail || typeof detail !== 'object') return
        try {
          window.dispatchEvent(new CustomEvent('ashlr:voice', { detail: detail }))
        } catch (_) {}
      },
      enumerable: false,
      writable: false,
      configurable: false
    })
  } catch (_) {}

  // Native → page: fleet operation progress (fleet_ops::event_script). Same
  // non-writable, non-configurable definition as the browser channel.
  try {
    Object.defineProperty(window, '__ASHLR_FLEET_EVENT__', {
      value: function (detail) {
        if (!detail || typeof detail !== 'object') return
        try {
          window.dispatchEvent(new CustomEvent('ashlr:fleet', { detail: detail }))
        } catch (_) {}
      },
      enumerable: false,
      writable: false,
      configurable: false
    })
  } catch (_) {}

  // Native → page: computer-use results and control-state changes
  // (computer::event_script). Locked down exactly like the browser channel.
  try {
    Object.defineProperty(window, '__ASHLR_COMPUTER_EVENT__', {
      value: function (detail) {
        if (!detail || typeof detail !== 'object') return
        try {
          window.dispatchEvent(new CustomEvent('ashlr:computer', { detail: detail }))
        } catch (_) {}
      },
      enumerable: false,
      writable: false,
      configurable: false
    })
  } catch (_) {}

  // Native → page: a new desktop state (desktop_prefs::state_script).
  window.__ASHLR_DESKTOP_STATE__ = function (next) {
    if (!next || typeof next !== 'object') return
    desktopState = next
    try {
      window.dispatchEvent(new CustomEvent('ashlr:desktop-state', { detail: copyState() }))
    } catch (_) {}
  }

  // Observation only. Installation is owned by native Quit and the verified host consumer.
  try {
    Object.defineProperty(window, '__ASHLR_UPDATE_STATE__', {
      value: function (next) {
        if (!next || typeof next !== 'object' || Array.isArray(next)) return
        try {
          updateState = JSON.parse(JSON.stringify(next))
          window.dispatchEvent(new CustomEvent('ashlr:update-state', { detail: copyUpdateState() }))
        } catch (_) {}
      },
      enumerable: false, writable: false, configurable: false
    })
  } catch (_) {}

  // 3. Drag regions ---------------------------------------------------------
  // The web UI marks its own top strip with data-app-region="drag" (and opts
  // interactive subtrees back out with data-app-region="no-drag"). Those are
  // mirrored onto the attribute Tauri's built-in drag handler understands, so
  // the web UI never has to know Tauri exists.
  var APP_ATTR = 'data-app-region'
  var TAURI_ATTR = 'data-tauri-drag-region'

  function syncOne(el) {
    if (!el || el.nodeType !== 1 || typeof el.getAttribute !== 'function') return
    var value = el.getAttribute(APP_ATTR)
    if (value === 'drag') {
      if (el.getAttribute(TAURI_ATTR) !== 'deep') el.setAttribute(TAURI_ATTR, 'deep')
    } else if (value === 'no-drag') {
      if (el.getAttribute(TAURI_ATTR) !== 'false') el.setAttribute(TAURI_ATTR, 'false')
    } else if (el.hasAttribute(TAURI_ATTR)) {
      el.removeAttribute(TAURI_ATTR)
    }
  }

  function syncTree(node) {
    if (!node || node.nodeType !== 1) return
    syncOne(node)
    if (typeof node.querySelectorAll !== 'function') return
    var found = node.querySelectorAll('[' + APP_ATTR + ']')
    for (var i = 0; i < found.length; i++) syncOne(found[i])
  }

  syncTree(root)

  try {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var record = records[i]
        if (record.type === 'attributes') {
          syncOne(record.target)
          continue
        }
        for (var j = 0; j < record.addedNodes.length; j++) syncTree(record.addedNodes[j])
      }
    }).observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [APP_ATTR]
    })
  } catch (_) {}

  // 4. Native → page commands ----------------------------------------------
  // The macOS menu bar, the tray, a clicked notification and the global
  // hotkey call this by eval (no IPC involved). The web UI just listens for
  // the event and parses it with command-catalog.ts `parseDesktopCommand`.
  window.__ASHLR_DESKTOP_COMMAND__ = function (command) {
    try {
      window.dispatchEvent(
        new CustomEvent('ashlr:desktop-command', { detail: { command: String(command) } })
      )
    } catch (_) {}
  }

  // 5. Fresh desktop state -------------------------------------------------
  // This script's copy is from when the window was created; a reload after a
  // Settings change would show stale values. Ask native for the live state —
  // it answers through window.__ASHLR_DESKTOP_STATE__.
  invoke('plugin:event|emit', { event: 'shell-state-request', payload: null })
})()
