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
    }
  })

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
  // The macOS menu bar calls this by eval (no IPC involved). The web UI just
  // listens for the event.
  window.__ASHLR_DESKTOP_COMMAND__ = function (command) {
    try {
      window.dispatchEvent(
        new CustomEvent('ashlr:desktop-command', { detail: { command: String(command) } })
      )
    } catch (_) {}
  }
})()
