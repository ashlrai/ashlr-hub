// Ashlr integrated browser — the read-only "tap" injected into every browser
// pane tab (browser_pane.rs, protocol v1), on ANY origin, main frame only,
// before the page's own scripts run.
//
// Rules this file must keep (browser_pane.rs has tests for them):
// - It only OBSERVES. It never reads form-control values, never submits a
//   form, never synthesises a click, a key press or an input event. The one
//   thing it swallows is the operator's own click while the element picker is
//   armed, so picking an element does not also activate it.
// - It must never throw into the page: every entry point is wrapped.
// - It is idempotent: a second evaluation is a no-op.
// - Every answer is a JSON *string* (native decodes it twice; see
//   `decode_tap_result`), built with the JSON.stringify captured here before
//   the page could replace it.
// - `window.__ashlrTap` is non-enumerable, non-writable and non-configurable,
//   so the page can neither swap it out nor delete it. The page can still read
//   what the tap captured (it is the page's own data), and a hostile page can
//   lie to it; native treats every answer as untrusted data, never as code.
;(function () {
  'use strict'
  try {
    if (Object.prototype.hasOwnProperty.call(window, '__ashlrTap')) return
  } catch (_) {
    return
  }

  var stringify = JSON.stringify
  var now = Date.now
  var CONSOLE_MAX = 200
  var NETWORK_MAX = 100
  var ENTRY_TEXT_MAX = 2000
  var URL_MAX = 500
  var consoleBuf = []
  var networkBuf = []

  function toJson(value) {
    try {
      return stringify.call(JSON, value)
    } catch (_) {
      return '{"error":"encode-failed"}'
    }
  }

  function cap(text, max) {
    var s = typeof text === 'string' ? text : String(text)
    return s.length > max ? s.slice(0, max) : s
  }

  function push(buf, max, entry) {
    buf.push(entry)
    if (buf.length > max) buf.splice(0, buf.length - max)
  }

  function formatOne(arg) {
    if (typeof arg === 'string') return arg
    try {
      if (arg instanceof Error) return String(arg.stack || arg.message || arg)
    } catch (_) {}
    if (arg !== null && typeof arg === 'object') {
      try {
        var json = stringify.call(JSON, arg)
        if (typeof json === 'string') return json
      } catch (_) {}
    }
    try {
      return String(arg)
    } catch (_) {
      return '[unprintable]'
    }
  }

  function formatArgs(args) {
    var out = ''
    for (var i = 0; i < args.length; i++) {
      if (out.length >= ENTRY_TEXT_MAX) break
      out += (i ? ' ' : '') + formatOne(args[i])
    }
    return cap(out, ENTRY_TEXT_MAX)
  }

  function recordConsole(level, text) {
    push(consoleBuf, CONSOLE_MAX, { t: now(), level: level, text: cap(text, ENTRY_TEXT_MAX) })
  }

  function recordNetwork(method, url, status, error) {
    var entry = { t: now(), method: cap(method || 'GET', 16), url: cap(url || '', URL_MAX), status: status }
    if (error) entry.error = cap(error, 300)
    push(networkBuf, NETWORK_MAX, entry)
  }

  // Console ------------------------------------------------------------------
  try {
    var levels = ['log', 'info', 'warn', 'error', 'debug']
    var c = window.console
    if (c) {
      for (var li = 0; li < levels.length; li++) {
        ;(function (level) {
          var original = c[level]
          if (typeof original !== 'function') return
          c[level] = function () {
            try {
              recordConsole(level, formatArgs(arguments))
            } catch (_) {}
            return original.apply(this, arguments)
          }
        })(levels[li])
      }
    }
  } catch (_) {}

  // Uncaught errors, and resource load failures (capture phase: a failed
  // <img>/<script> error event does not bubble to window) -------------------
  var RESOURCE_TAGS = { IMG: 1, SCRIPT: 1, LINK: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1, SOURCE: 1 }
  try {
    window.addEventListener(
      'error',
      function (event) {
        try {
          var target = event && event.target
          if (target && target !== window && target.tagName && RESOURCE_TAGS[target.tagName]) {
            var src = target.src || target.href || target.currentSrc || ''
            recordNetwork('GET', String(src), null, 'failed to load ' + String(target.tagName).toLowerCase())
            return
          }
          var message = (event && event.message) || 'error'
          var where = event && event.filename ? ' (' + event.filename + ':' + event.lineno + ':' + event.colno + ')' : ''
          var stack = event && event.error && event.error.stack ? '\n' + event.error.stack : ''
          recordConsole('error', 'Uncaught ' + message + where + stack)
        } catch (_) {}
      },
      true
    )
    window.addEventListener('unhandledrejection', function (event) {
      try {
        recordConsole('error', 'Uncaught (in promise) ' + formatOne(event ? event.reason : ''))
      } catch (_) {}
    })
  } catch (_) {}

  // fetch ----------------------------------------------------------------------
  try {
    var originalFetch = window.fetch
    if (typeof originalFetch === 'function') {
      window.fetch = function (input, init) {
        var method = 'GET'
        var url = ''
        try {
          if (init && init.method) method = String(init.method)
          else if (input && typeof input === 'object' && input.method) method = String(input.method)
          url = typeof input === 'string' ? input : input && (input.url || input.href) ? String(input.url || input.href) : String(input)
        } catch (_) {}
        var result = originalFetch.apply(this, arguments)
        try {
          if (result && typeof result.then === 'function') {
            result.then(
              function (response) {
                try {
                  if (response && response.status >= 400) recordNetwork(method.toUpperCase(), url, response.status)
                } catch (_) {}
              },
              function (err) {
                try {
                  recordNetwork(method.toUpperCase(), url, null, String((err && err.message) || err || 'failed'))
                } catch (_) {}
              }
            )
          }
        } catch (_) {}
        return result
      }
    }
  } catch (_) {}

  // XMLHttpRequest ---------------------------------------------------------------
  try {
    var XHR = window.XMLHttpRequest
    if (XHR && XHR.prototype) {
      var meta = typeof WeakMap === 'function' ? new WeakMap() : null
      var originalOpen = XHR.prototype.open
      var originalSend = XHR.prototype.send
      if (meta && typeof originalOpen === 'function' && typeof originalSend === 'function') {
        XHR.prototype.open = function (method, url) {
          try {
            meta.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url || '') })
          } catch (_) {}
          return originalOpen.apply(this, arguments)
        }
        XHR.prototype.send = function () {
          try {
            var xhr = this
            var info = meta.get(xhr)
            if (info && !info.hooked) {
              info.hooked = true
              xhr.addEventListener('loadend', function () {
                try {
                  var status = xhr.status
                  if (status === 0) recordNetwork(info.method, info.url, null, 'network error')
                  else if (status >= 400) recordNetwork(info.method, info.url, status)
                } catch (_) {}
              })
            }
          } catch (_) {}
          return originalSend.apply(this, arguments)
        }
      }
    }
  } catch (_) {}

  // Reads ------------------------------------------------------------------------
  function pageUrl() {
    try {
      return String(window.location.href)
    } catch (_) {
      return ''
    }
  }

  function pageTitle() {
    try {
      return cap(String(document.title || ''), 300)
    } catch (_) {
      return ''
    }
  }

  function lastOf(buf, limit) {
    var n = Math.max(1, Math.min(typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 200, 200))
    return buf.slice(Math.max(0, buf.length - n))
  }

  function dump(limit) {
    return toJson({ url: pageUrl(), title: pageTitle(), console: lastOf(consoleBuf, limit), network: lastOf(networkBuf, limit) })
  }

  function text(max) {
    var limit = typeof max === 'number' && max > 0 ? Math.floor(max) : 20000
    var body = ''
    try {
      body = document.body ? String(document.body.innerText || '') : ''
    } catch (_) {}
    return toJson({ url: pageUrl(), title: pageTitle(), text: body.slice(0, limit), truncated: body.length > limit })
  }

  function info() {
    var state = ''
    try {
      state = String(document.readyState)
    } catch (_) {}
    return toJson({ url: pageUrl(), title: pageTitle(), readyState: state })
  }

  // Element picker -----------------------------------------------------------------
  var pick = { state: 'idle', result: null, overlay: null, listeners: [] }

  function escapeIdent(s) {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s)
    } catch (_) {}
    return null
  }

  function uniqueIdSelector(el) {
    try {
      var id = el.id
      if (!id || typeof id !== 'string') return null
      var escaped = escapeIdent(id)
      if (!escaped) return null
      var sel = '#' + escaped
      return document.querySelectorAll(sel).length === 1 ? sel : null
    } catch (_) {
      return null
    }
  }

  function segment(el) {
    var tag = String(el.tagName || '').toLowerCase()
    var part = tag
    try {
      var list = el.classList
      if (list) {
        for (var i = 0, added = 0; i < list.length && added < 3; i++) {
          var cls = escapeIdent(list[i])
          if (cls) {
            part += '.' + cls
            added++
          }
        }
      }
    } catch (_) {}
    try {
      var parent = el.parentElement
      if (parent) {
        var index = 0
        var count = 0
        for (var child = parent.firstElementChild; child; child = child.nextElementSibling) {
          if (child.tagName === el.tagName) {
            count++
            if (child === el) index = count
          }
        }
        if (count > 1) part += ':nth-of-type(' + index + ')'
      }
    } catch (_) {}
    return part
  }

  function selectorFor(el) {
    var own = uniqueIdSelector(el)
    if (own) return own
    var parts = []
    var node = el
    for (var depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      if (depth > 0) {
        var anchor = uniqueIdSelector(node)
        if (anchor) {
          parts.unshift(anchor)
          break
        }
      }
      parts.unshift(segment(node))
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  // outerHTML carries only markup attributes, never what was typed into a
  // field; the value attributes of <input> tags are still stripped, so a
  // server-rendered default can never ride along either.
  function markupOf(el) {
    var html = ''
    try {
      html = String(el.outerHTML || '')
    } catch (_) {}
    html = html.replace(/(<input\b[^>]*?)\s+value\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1')
    return html.length > 2000 ? html.slice(0, 2000) + '…' : html
  }

  function describe(el) {
    var rect = { x: 0, y: 0, width: 0, height: 0 }
    try {
      var r = el.getBoundingClientRect()
      rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    } catch (_) {}
    var inner = ''
    try {
      inner = String(el.innerText || el.textContent || '')
    } catch (_) {}
    return {
      selector: selectorFor(el),
      html: markupOf(el),
      text: inner.slice(0, 300),
      tag: String(el.tagName || '').toLowerCase(),
      rect: rect
    }
  }

  function stopPicking() {
    for (var i = 0; i < pick.listeners.length; i++) {
      try {
        window.removeEventListener(pick.listeners[i][0], pick.listeners[i][1], true)
      } catch (_) {}
    }
    pick.listeners = []
    try {
      if (pick.overlay && pick.overlay.parentNode) pick.overlay.parentNode.removeChild(pick.overlay)
    } catch (_) {}
    pick.overlay = null
  }

  function listen(type, fn) {
    window.addEventListener(type, fn, true)
    pick.listeners.push([type, fn])
  }

  function swallow(event) {
    try {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    } catch (_) {}
  }

  function pickStart() {
    if (pick.state === 'picking') return toJson({ state: 'picking' })
    stopPicking()
    pick.result = null
    var overlay = document.createElement('div')
    overlay.setAttribute('data-ashlr-picker', '')
    overlay.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;' +
      'outline:2px solid #4f7cff;outline-offset:-1px;background:rgba(79,124,255,0.12);' +
      'z-index:2147483647;box-sizing:border-box;margin:0;padding:0;border:0;display:none'
    ;(document.documentElement || document.body).appendChild(overlay)
    pick.overlay = overlay
    pick.state = 'picking'

    listen('mouseover', function (event) {
      try {
        var target = event.target
        if (!target || target.nodeType !== 1 || target === overlay) return
        var r = target.getBoundingClientRect()
        overlay.style.left = r.left + 'px'
        overlay.style.top = r.top + 'px'
        overlay.style.width = r.width + 'px'
        overlay.style.height = r.height + 'px'
        overlay.style.display = 'block'
      } catch (_) {}
    })
    // The page must not see the press that picks: swallow the whole sequence,
    // not only the click, so mousedown-driven widgets do not fire either.
    listen('pointerdown', swallow)
    listen('mousedown', swallow)
    listen('pointerup', swallow)
    listen('mouseup', swallow)
    listen('click', function (event) {
      swallow(event)
      try {
        var target = event.target
        if (target && target.nodeType === 1) {
          pick.result = describe(target)
          pick.state = 'picked'
        } else {
          pick.state = 'idle'
        }
      } catch (_) {
        pick.state = 'idle'
      }
      stopPicking()
    })
    listen('keydown', function (event) {
      try {
        if (event.key === 'Escape' || event.key === 'Esc') {
          swallow(event)
          pick.state = 'idle'
          pick.result = null
          stopPicking()
        }
      } catch (_) {}
    })
    return toJson({ state: 'picking' })
  }

  function pickPoll() {
    if (pick.state === 'picked') {
      var result = pick.result
      pick.state = 'idle'
      pick.result = null
      return toJson({ state: 'picked', result: result })
    }
    return toJson({ state: pick.state })
  }

  function pickCancel() {
    stopPicking()
    pick.state = 'idle'
    pick.result = null
    return toJson({ state: 'idle' })
  }

  function guard(fn) {
    return function () {
      try {
        return fn.apply(null, arguments)
      } catch (e) {
        return toJson({ error: String((e && e.message) || e) })
      }
    }
  }

  var api = {
    version: 1,
    dump: guard(dump),
    text: guard(text),
    info: guard(info),
    pickStart: guard(pickStart),
    pickPoll: guard(pickPoll),
    pickCancel: guard(pickCancel)
  }
  try {
    Object.freeze(api)
  } catch (_) {}
  try {
    Object.defineProperty(window, '__ashlrTap', {
      value: api,
      enumerable: false,
      configurable: false,
      writable: false
    })
  } catch (_) {}
})()
