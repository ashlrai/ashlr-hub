// Ashlr integrated browser — the "tap" injected into every browser pane tab
// (browser_pane.rs), on ANY origin, main frame only, before the page's own
// scripts run.
//
// Rules this file must keep (browser_pane.rs has tests for them):
// - It OBSERVES, and it PREPARES native input. The agent's clicks and key
//   presses are synthesised by native as real (trusted) NSEvents into the
//   webview; the tap never calls an element's click or form-submit methods and
//   never evaluates a string. What it does itself is narrow and listed here:
//   scrolling (scrollIntoView / scrollBy), selecting a field's existing text
//   before native deletes it (`clear`) or moving the caret to its end before
//   native types, choosing <select> options (a native
//   popup menu would block the app), a synthetic contextmenu for a right
//   click (the native menu would block too), and drawing the click ring. The
//   only two event dispatches in this file are those last two.
// - It reads a form field's content in exactly one place, `fieldValue`, and
//   only after `sensitive` said the field is not a password, payment, SSN or
//   secret field: those always read as [redacted] and can never be typed into
//   (`prepare` refuses; the sidecar refuses first).
// - It must never throw into the page: every entry point is wrapped.
// - It is idempotent: a second evaluation is a no-op.
// - Every answer is a JSON *string* (native decodes it twice; see
//   `decode_tap_result`), built with the JSON.stringify captured here before
//   the page could replace it.
// - `window.__ashlrTap` is non-enumerable, non-writable and non-configurable,
//   so the page can neither swap it out nor delete it. The page can still read
//   what the tap captured (it is the page's own data), and a hostile page can
//   lie to it; native and the sidecar treat every answer as untrusted data,
//   never as code or as instructions.
;(function () {
  'use strict'

  // No microphone, camera or screen capture for a page in the pane. Native
  // denies it too (media_guard.rs swaps wry's grant-everything WKUIDelegate
  // for a deny proxy, which also covers iframes); this layer makes the refusal
  // immediate and covers the legacy callback APIs. Runs before the idempotency
  // guard on purpose, and is itself idempotent: a second run's
  // defineProperty on a locked property throws and is swallowed.
  ;(function () {
    var MESSAGE = 'Media capture is disabled in the Phantom browser pane.'
    function refusal() {
      try {
        var DomException = window.DOMException
        if (typeof DomException === 'function') return new DomException(MESSAGE, 'NotAllowedError')
      } catch (_) {}
      var e = new Error(MESSAGE)
      e.name = 'NotAllowedError'
      return e
    }
    function denied() {
      return Promise.reject(refusal())
    }
    function noDevices() {
      return Promise.resolve([])
    }
    function legacyDenied(_constraints, _onSuccess, onError) {
      if (typeof onError === 'function') {
        try {
          onError(refusal())
        } catch (_) {}
      }
    }
    function lock(target, name, fn) {
      if (!target) return
      try {
        Object.defineProperty(target, name, {
          value: fn,
          writable: false,
          configurable: false,
          enumerable: false
        })
      } catch (_) {}
    }
    try {
      var MD = window.MediaDevices
      var targets = [MD && MD.prototype, navigator.mediaDevices]
      for (var i = 0; i < targets.length; i++) {
        lock(targets[i], 'getUserMedia', denied)
        lock(targets[i], 'getDisplayMedia', denied)
        lock(targets[i], 'enumerateDevices', noDevices)
      }
      var NP = window.Navigator && window.Navigator.prototype
      var legacy = ['getUserMedia', 'webkitGetUserMedia']
      for (var j = 0; j < legacy.length; j++) {
        lock(NP, legacy[j], legacyDenied)
        lock(navigator, legacy[j], legacyDenied)
      }
    } catch (_) {}
  })()

  try {
    if (Object.prototype.hasOwnProperty.call(window, '__ashlrTap')) return
  } catch (_) {
    return
  }

  var stringify = JSON.stringify
  var now = Date.now
  var CONSOLE_MAX = 200
  var NETWORK_MAX = 100
  var REQUEST_MAX = 300
  var ENTRY_TEXT_MAX = 2000
  var URL_MAX = 500
  var consoleBuf = []
  var networkBuf = []
  var requestBuf = []
  var loadId = randomId()

  function randomId() {
    try {
      var a = new Uint32Array(2)
      window.crypto.getRandomValues(a)
      return (a[0].toString(36) + a[1].toString(36)).slice(0, 12)
    } catch (_) {
      return String(Math.random()).slice(2, 12)
    }
  }

  function toJson(value) {
    try {
      return stringify.call(JSON, value)
    } catch (_) {
      return '{"error":"encode-failed"}'
    }
  }

  function fail(code) {
    return toJson({ error: code })
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

  // Every fetch / XHR, metadata only: method, URL, status, timing and sizes.
  // Never a body, never a header (the only header read is the response's
  // content-length, for the size).
  function recordRequest(kind, method, url, started, status, resBytes, reqBytes, error) {
    var entry = {
      t: started,
      type: kind,
      method: cap(method || 'GET', 16),
      url: cap(url || '', URL_MAX),
      status: status,
      ms: Math.max(0, now() - started)
    }
    if (typeof resBytes === 'number' && resBytes >= 0) entry.resBytes = resBytes
    if (typeof reqBytes === 'number' && reqBytes >= 0) entry.reqBytes = reqBytes
    if (error) entry.error = cap(error, 300)
    push(requestBuf, REQUEST_MAX, entry)
  }

  function bodySize(body) {
    try {
      if (body === null || body === undefined) return null
      if (typeof body === 'string') return body.length
      if (typeof body.byteLength === 'number') return body.byteLength
      if (typeof body.size === 'number') return body.size
    } catch (_) {}
    return null
  }

  function lengthHeader(raw) {
    var n = parseInt(String(raw || ''), 10)
    return isFinite(n) && n >= 0 ? n : null
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
        var reqBytes = null
        var started = now()
        try {
          if (init && init.method) method = String(init.method)
          else if (input && typeof input === 'object' && input.method) method = String(input.method)
          url = typeof input === 'string' ? input : input && (input.url || input.href) ? String(input.url || input.href) : String(input)
          if (init && init.body !== undefined) reqBytes = bodySize(init.body)
        } catch (_) {}
        var result = originalFetch.apply(this, arguments)
        try {
          if (result && typeof result.then === 'function') {
            result.then(
              function (response) {
                try {
                  var m = method.toUpperCase()
                  var size = null
                  try {
                    size = lengthHeader(response.headers.get('content-length'))
                  } catch (_) {}
                  recordRequest('fetch', m, url, started, response ? response.status : null, size, reqBytes)
                  if (response && response.status >= 400) recordNetwork(m, url, response.status)
                } catch (_) {}
              },
              function (err) {
                try {
                  var why = String((err && err.message) || err || 'failed')
                  recordRequest('fetch', method.toUpperCase(), url, started, null, null, reqBytes, why)
                  recordNetwork(method.toUpperCase(), url, null, why)
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
        XHR.prototype.send = function (body) {
          try {
            var info = meta.get(this)
            if (info && !info.hooked) {
              info.hooked = true
              info.started = now()
              info.reqBytes = bodySize(body)
              // A DOM listener's `this` is the XHR it is attached to, so no alias is needed.
              this.addEventListener('loadend', function () {
                try {
                  var status = this.status
                  var size = null
                  try {
                    size = lengthHeader(this.getResponseHeader('content-length'))
                  } catch (_) {}
                  recordRequest('xhr', info.method, info.url, info.started, status === 0 ? null : status, size, info.reqBytes, status === 0 ? 'network error' : '')
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

  function viewport() {
    var out = { vw: 0, vh: 0, sx: 0, sy: 0, dw: 0, dh: 0 }
    try {
      out.vw = Math.round(window.innerWidth || 0)
      out.vh = Math.round(window.innerHeight || 0)
      out.sx = Math.round(window.scrollX || 0)
      out.sy = Math.round(window.scrollY || 0)
      var root = document.documentElement
      out.dw = Math.round((root && root.scrollWidth) || 0)
      out.dh = Math.round((root && root.scrollHeight) || 0)
    } catch (_) {}
    return out
  }

  function lastOf(buf, limit, ceiling) {
    var top = ceiling || 200
    var n = Math.max(1, Math.min(typeof limit === 'number' && limit > 0 ? Math.floor(limit) : top, top))
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
    var v = viewport()
    return toJson({ url: pageUrl(), title: pageTitle(), readyState: state, loadId: loadId, vw: v.vw, vh: v.vh, sx: v.sx, sy: v.sy, dw: v.dw, dh: v.dh })
  }

  function network(opts) {
    var limit = opts && typeof opts.limit === 'number' ? opts.limit : 100
    return toJson({ url: pageUrl(), title: pageTitle(), requests: lastOf(requestBuf, limit, REQUEST_MAX) })
  }

  // Element refs -------------------------------------------------------------------
  // `e<n>` names an element for the life of this page load (a WeakMap keeps no
  // element alive). A new page restarts the numbering, so every answer that
  // carries refs also carries `loadId`: the sidecar refuses a ref from an
  // older page instead of acting on whatever now has that number.
  var refOf = typeof WeakMap === 'function' ? new WeakMap() : null
  var refIndex = Object.create(null)
  var refCount = 0
  var nextRef = 1
  var HAS_WEAKREF = typeof WeakRef === 'function'
  var REF_MAX = 50000

  function refFor(el) {
    if (!refOf) return null
    var id = refOf.get(el)
    if (id) return id
    if (refCount >= REF_MAX) {
      refIndex = Object.create(null)
      refCount = 0
      refOf = new WeakMap()
    }
    id = 'e' + nextRef++
    refOf.set(el, id)
    refIndex[id] = HAS_WEAKREF ? new WeakRef(el) : el
    refCount++
    return id
  }

  function elForRef(id) {
    if (typeof id !== 'string' || !/^e[1-9][0-9]{0,6}$/.test(id)) return null
    var held = refIndex[id]
    if (!held) return null
    var el = HAS_WEAKREF ? held.deref() : held
    if (!el || !el.isConnected) return null
    return el
  }

  // Roles, names and state (a practical subset of the ARIA mappings) ----------------
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, BASE: 1, TITLE: 1 }
  var LEAF_ROLES = {
    button: 1, link: 1, heading: 1, textbox: 1, searchbox: 1, checkbox: 1, radio: 1, switch: 1, slider: 1,
    spinbutton: 1, option: 1, img: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1,
    progressbar: 1, separator: 1, meter: 1, treeitem: 1
  }
  var CONTROL_ROLES = {
    button: 1, link: 1, textbox: 1, searchbox: 1, checkbox: 1, radio: 1, switch: 1, slider: 1, spinbutton: 1,
    combobox: 1, listbox: 1, option: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, treeitem: 1
  }
  var NAME_FROM_CONTENT = {
    button: 1, link: 1, heading: 1, option: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1,
    cell: 1, columnheader: 1, rowheader: 1, treeitem: 1, switch: 1, checkbox: 1, radio: 1, tooltip: 1
  }
  var INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', color: 'button', hidden: ''
  }
  var TAG_ROLES = {
    BUTTON: 'button', TEXTAREA: 'textbox', OPTION: 'option', NAV: 'navigation', MAIN: 'main',
    HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', UL: 'list', OL: 'list',
    MENU: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', DIALOG: 'dialog',
    SUMMARY: 'button', P: 'paragraph', IFRAME: 'iframe', PROGRESS: 'progressbar', METER: 'meter', HR: 'separator',
    ARTICLE: 'article', FIGURE: 'figure', BLOCKQUOTE: 'blockquote', DL: 'list', DT: 'term', DD: 'definition'
  }

  function attr(el, name) {
    try {
      var v = el.getAttribute(name)
      return v === null ? null : String(v)
    } catch (_) {
      return null
    }
  }

  function inputType(el) {
    return (attr(el, 'type') || 'text').toLowerCase()
  }

  function roleOf(el) {
    var explicit = attr(el, 'role')
    if (explicit) {
      var first = explicit.trim().split(/\s+/)[0].toLowerCase()
      if (first && first !== 'none' && first !== 'presentation') return first
      if (first === 'none' || first === 'presentation') return ''
    }
    var tag = el.tagName
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : ''
    if (tag === 'INPUT') {
      var type = inputType(el)
      return Object.prototype.hasOwnProperty.call(INPUT_ROLES, type) ? INPUT_ROLES[type] : 'textbox'
    }
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
    if (/^H[1-6]$/.test(tag)) return 'heading'
    if (tag === 'IMG') return attr(el, 'alt') === '' ? '' : 'img'
    if (tag === 'SECTION') return attr(el, 'aria-label') || attr(el, 'aria-labelledby') ? 'region' : ''
    if (Object.prototype.hasOwnProperty.call(TAG_ROLES, tag)) return TAG_ROLES[tag]
    try {
      if (el.isContentEditable && attr(el, 'contenteditable') !== null) return 'textbox'
    } catch (_) {}
    return ''
  }

  function squash(s, max) {
    return cap(String(s || '').replace(/\s+/g, ' ').trim(), max)
  }

  function textOf(el, max) {
    try {
      return squash(el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent, max)
    } catch (_) {
      return ''
    }
  }

  function labelledBy(el) {
    var ids = attr(el, 'aria-labelledby')
    if (!ids) return ''
    var parts = []
    var list = ids.trim().split(/\s+/)
    for (var i = 0; i < list.length && i < 5; i++) {
      try {
        var target = document.getElementById(list[i])
        if (target) parts.push(textOf(target, 150))
      } catch (_) {}
    }
    return squash(parts.join(' '), 150)
  }

  function labelFor(el) {
    try {
      if (el.id) {
        // Compared, never spliced into a selector.
        var labels = document.getElementsByTagName('label')
        for (var i = 0; i < labels.length && i < 500; i++) {
          if (labels[i].htmlFor === el.id) return textOf(labels[i], 150)
        }
      }
      var wrap = el.closest ? el.closest('label') : null
      if (wrap) return textOf(wrap, 150)
    } catch (_) {}
    return ''
  }

  function nameOf(el, role) {
    var name = labelledBy(el) || squash(attr(el, 'aria-label'), 150)
    if (name) return name
    var tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      var type = tag === 'INPUT' ? inputType(el) : ''
      if (type === 'submit' || type === 'reset' || type === 'button') {
        return squash(attr(el, 'value'), 150) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '')
      }
      if (type === 'image') return squash(attr(el, 'alt'), 150) || 'Submit'
      name = labelFor(el) || squash(attr(el, 'placeholder'), 150) || squash(attr(el, 'title'), 150)
      return name
    }
    if (tag === 'IMG') return squash(attr(el, 'alt'), 150) || squash(attr(el, 'title'), 150)
    if (NAME_FROM_CONTENT[role]) {
      name = textOf(el, 150)
      if (name) return name
    }
    return squash(attr(el, 'title'), 150)
  }

  // Sensitive fields. The same pattern lives in core/verse/browser-act-policy.ts
  // (a test keeps them identical); the hint is normalised first (camelCase and
  // _-.:[] become spaces) so word boundaries work on `user_password` and
  // `creditCardNumber` alike.
  var SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password$|new-password$|one-time-code$)/
  var SENSITIVE_HINT = /\b(pass ?(word|wd|code|phrase)|pwd|pin|otp|one ?time|cvc|cvv2?|csc|security ?code|card ?(number|no|num)|cc ?(num|number|no)|credit ?card|ssn|social ?security|tax ?id|iban|routing ?(number|no)|account ?(number|no|num)|sort ?code|passport|secret|api ?key|private ?key|token)\b/

  function normaliseHint(s) {
    return String(s || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-.:[\]]+/g, ' ')
      .toLowerCase()
  }

  function sensitive(el) {
    try {
      if (!el || el.nodeType !== 1) return false
      if (el.tagName === 'INPUT' && inputType(el) === 'password') return true
      var tokens = (attr(el, 'autocomplete') || '').toLowerCase().split(/\s+/)
      for (var i = 0; i < tokens.length; i++) {
        if (tokens[i] && SENSITIVE_AUTOCOMPLETE.test(tokens[i])) return true
      }
      var hint = [attr(el, 'name'), el.id, attr(el, 'aria-label'), attr(el, 'placeholder'), labelledBy(el), labelFor(el)].join(' ')
      return SENSITIVE_HINT.test(normaliseHint(hint))
    } catch (_) {
      // Unsure is sensitive.
      return true
    }
  }

  function isTextField(el) {
    var tag = el.tagName
    if (tag === 'TEXTAREA') return true
    if (tag === 'INPUT') return !Object.prototype.hasOwnProperty.call(INPUT_ROLES, inputType(el)) || inputType(el) === 'search' || inputType(el) === 'number'
    try {
      return !!el.isContentEditable
    } catch (_) {
      return false
    }
  }

  // The ONLY place a field's content is read.
  function fieldValue(el) {
    if (sensitive(el)) return '[redacted]'
    try {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        var v = el.value
        return cap(String(v === null || v === undefined ? '' : v), 200)
      }
      if (el.isContentEditable) return textOf(el, 200)
    } catch (_) {}
    return ''
  }

  function selectedLabels(el) {
    var out = []
    try {
      var options = el.options || []
      for (var i = 0; i < options.length && out.length < 20; i++) {
        if (options[i].selected) out.push(squash(options[i].label || options[i].text, 100))
      }
    } catch (_) {}
    return out
  }

  function states(el, role) {
    var s = []
    try {
      if (el.disabled || attr(el, 'aria-disabled') === 'true') s.push('disabled')
      if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
        var ac = attr(el, 'aria-checked')
        if (el.tagName === 'INPUT' ? el.checked : ac === 'true') s.push('checked')
        else if (ac === 'mixed' || el.indeterminate) s.push('mixed')
      }
      var expanded = attr(el, 'aria-expanded')
      if (expanded === 'true') s.push('expanded')
      else if (expanded === 'false') s.push('collapsed')
      if (role === 'option' ? el.selected || attr(el, 'aria-selected') === 'true' : attr(el, 'aria-selected') === 'true') s.push('selected')
      if (attr(el, 'aria-pressed') === 'true') s.push('pressed')
      if (el.required || attr(el, 'aria-required') === 'true') s.push('required')
      if (el.readOnly || attr(el, 'aria-readonly') === 'true') s.push('readonly')
      if (document.activeElement === el) s.push('focused')
    } catch (_) {}
    return s
  }

  function hiddenByStyle(el) {
    try {
      if (el.hidden) return true
      if (attr(el, 'aria-hidden') === 'true') return true
      if (attr(el, 'data-ashlr-picker') !== null || attr(el, 'data-ashlr-ring') !== null) return true
      var cs = window.getComputedStyle(el)
      if (!cs) return false
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true
      // Text nobody can see is a classic place to hide instructions for an
      // agent: transparent and zero-size content is left out too.
      if (cs.opacity === '0') return true
      if (parseFloat(cs.fontSize) === 0 && el.children.length === 0) return true
    } catch (_) {}
    return false
  }

  function rectOf(el) {
    try {
      var r = el.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    } catch (_) {
      return { x: 0, y: 0, width: 0, height: 0 }
    }
  }

  function offscreen(r, v) {
    return r.x + r.width <= 0 || r.y + r.height <= 0 || r.x >= v.vw || r.y >= v.vh
  }

  function headingLevel(el) {
    var aria = parseInt(attr(el, 'aria-level') || '', 10)
    if (isFinite(aria) && aria > 0) return aria
    var m = /^H([1-6])$/.exec(el.tagName)
    return m ? parseInt(m[1], 10) : null
  }

  function hash(s) {
    var h = 0x811c9dc5
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(36)
  }

  // What the element IS, for "is this still the thing the operator approved?"
  function sigOf(el) {
    var role = roleOf(el)
    return hash([el.tagName, role, nameOf(el, role), el.tagName === 'INPUT' ? inputType(el) : '', attr(el, 'href') || ''].join('|'))
  }

  // Snapshot ------------------------------------------------------------------------
  var SNAPSHOT_VISIT_MAX = 25000

  function snapshot(opts) {
    var o = opts || {}
    var maxNodes = typeof o.maxNodes === 'number' && o.maxNodes > 0 ? Math.min(Math.floor(o.maxNodes), 2000) : 400
    var root = document.body || document.documentElement
    if (o.rootRef) {
      root = elForRef(o.rootRef)
      if (!root) return fail('stale-ref')
    }
    var v = viewport()
    var nodes = []
    var visited = 0
    var truncated = false

    function emit(node) {
      if (nodes.length >= maxNodes) {
        truncated = true
        return false
      }
      nodes.push(node)
      return true
    }

    function walk(el, depth) {
      if (truncated || visited >= SNAPSHOT_VISIT_MAX) {
        truncated = true
        return
      }
      visited++
      if (!el || el.nodeType !== 1 || SKIP_TAGS[el.tagName]) return
      if (hiddenByStyle(el)) return
      if (el.tagName === 'INPUT' && inputType(el) === 'hidden') return
      var role = roleOf(el)
      var childDepth = depth
      if (role) {
        var node = { d: depth, role: role, ref: refFor(el) }
        var name = nameOf(el, role)
        if (name) node.name = name
        var st = states(el, role)
        var r = rectOf(el)
        if (CONTROL_ROLES[role] && (r.width === 0 || r.height === 0)) st.push('zero-size')
        if (offscreen(r, v)) st.push('offscreen')
        if (st.length) node.states = st
        if (role === 'heading') node.level = headingLevel(el)
        if (role === 'link') {
          try {
            node.href = cap(String(el.href || attr(el, 'href') || ''), 300)
          } catch (_) {}
        }
        if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton') {
          if (sensitive(el)) node.sensitive = true
          node.val = fieldValue(el)
        } else if (role === 'combobox' || role === 'listbox') {
          if (el.tagName === 'SELECT') node.val = selectedLabels(el).join(', ')
        } else if (role === 'slider') {
          node.val = squash(attr(el, 'aria-valuetext') || attr(el, 'aria-valuenow') || '', 50)
        }
        if (!emit(node)) return
        childDepth = depth + 1
        // A leaf's text is its name; its insides are not listed again. A
        // <select> is walked for its options.
        if (LEAF_ROLES[role] && el.tagName !== 'SELECT') return
      }
      for (var child = el.firstChild; child; child = child.nextSibling) {
        if (truncated) return
        if (child.nodeType === 3) {
          var t = squash(child.nodeValue, 300)
          if (t && !(role && LEAF_ROLES[role])) {
            if (!emit({ d: childDepth, role: 'text', name: t })) return
          }
        } else if (child.nodeType === 1) {
          walk(child, childDepth)
          // Open shadow roots are part of what the operator sees.
          try {
            if (child.shadowRoot) {
              for (var s = child.shadowRoot.firstElementChild; s; s = s.nextElementSibling) walk(s, childDepth + 1)
            }
          } catch (_) {}
        }
      }
    }

    walk(root, 0)
    return toJson({ url: pageUrl(), title: pageTitle(), loadId: loadId, vw: v.vw, vh: v.vh, nodes: nodes, truncated: truncated })
  }

  // Resolve: what a ref (or a point) is, for the sidecar's safety decision ------------
  function elementAt(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return null
    try {
      var el = document.elementFromPoint(x, y)
      return el && el.nodeType === 1 ? el : null
    } catch (_) {
      return null
    }
  }

  function describeTarget(el) {
    var role = roleOf(el)
    var tag = el.tagName
    var out = {
      ref: refFor(el),
      sig: sigOf(el),
      loadId: loadId,
      role: role || 'generic',
      name: nameOf(el, role),
      tag: tag.toLowerCase(),
      rect: rectOf(el),
      url: pageUrl()
    }
    var v = viewport()
    out.vw = v.vw
    out.vh = v.vh
    if (tag === 'INPUT') out.type = inputType(el)
    out.sensitive = sensitive(el)
    out.editable = isTextField(el) && !el.disabled && !el.readOnly
    out.multiline = tag === 'TEXTAREA' || (!!el.isContentEditable && tag !== 'INPUT')
    out.disabled = !!el.disabled || attr(el, 'aria-disabled') === 'true'
    out.hidden = hiddenByStyle(el)
    // Would activating it submit a form? A <button> is type=submit unless it
    // says otherwise; Enter in a single-line field submits its form too.
    var form = null
    try {
      form = el.form || (el.closest ? el.closest('form') : null)
    } catch (_) {}
    var type = (tag === 'INPUT' || tag === 'BUTTON') ? (attr(el, 'type') || (tag === 'BUTTON' ? 'submit' : 'text')).toLowerCase() : ''
    out.inForm = !!form
    out.submits = !!form && ((tag === 'BUTTON' && type === 'submit') || (tag === 'INPUT' && (type === 'submit' || type === 'image')))
    if (form) {
      try {
        out.formAction = cap(String(form.action || pageUrl()), 500)
        out.formMethod = String(attr(form, 'method') || 'get').toLowerCase()
      } catch (_) {}
    }
    // A link's destination (clicks inside it land on it too).
    var link = null
    try {
      link = el.closest ? el.closest('a[href]') : null
    } catch (_) {}
    if (link) {
      try {
        out.href = cap(String(link.href || ''), 500)
        out.download = link.hasAttribute('download')
        out.newWindow = (attr(link, 'target') || '').toLowerCase() === '_blank'
      } catch (_) {}
    }
    out.select = tag === 'SELECT'
    out.fileInput = tag === 'INPUT' && inputType(el) === 'file'
    return out
  }

  function resolve(target) {
    var t = target || {}
    var el = null
    if (t.focused === true) {
      el = document.activeElement
      if (!el || el === document.body || el === document.documentElement) return fail('nothing-focused')
    } else {
      el = t.ref ? elForRef(t.ref) : elementAt(t.x, t.y)
    }
    if (!el) return fail(t.ref ? 'stale-ref' : 'nothing-there')
    return toJson(describeTarget(el))
  }

  // Acting ---------------------------------------------------------------------------
  // Native synthesises the clicks and key presses; the tap finds the point,
  // re-checks that the element is still the one the sidecar judged
  // (`expect` = its sig), refuses what must never be done, and does the few
  // things listed at the top of this file itself.
  var PRINTABLE_KEY = /^(?:[!-~]|Space)$/

  function ring(x, y) {
    try {
      var dot = document.createElement('div')
      dot.setAttribute('data-ashlr-ring', '')
      dot.style.cssText =
        'position:fixed;left:' + (x - 14) + 'px;top:' + (y - 14) + 'px;width:28px;height:28px;border-radius:50%;' +
        'border:3px solid #4f7cff;box-shadow:0 0 0 3px rgba(79,124,255,0.25);pointer-events:none;' +
        'z-index:2147483647;box-sizing:border-box;margin:0;padding:0;background:transparent;transition:opacity 0.6s ease-out;opacity:1'
      ;(document.documentElement || document.body).appendChild(dot)
      setTimeout(function () {
        try {
          dot.style.opacity = '0'
        } catch (_) {}
      }, 250)
      setTimeout(function () {
        try {
          if (dot.parentNode) dot.parentNode.removeChild(dot)
        } catch (_) {}
      }, 1000)
    } catch (_) {}
  }

  function inViewport(r, v) {
    return r.x >= 0 && r.y >= 0 && r.x + r.width <= v.vw && r.y + r.height <= v.vh
  }

  function pointFor(el) {
    var v = viewport()
    var r = rectOf(el)
    if (r.width <= 0 || r.height <= 0) return { error: 'not-visible' }
    if (!inViewport(r, v)) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      } catch (_) {
        try {
          el.scrollIntoView()
        } catch (_) {}
      }
      r = rectOf(el)
      v = viewport()
    }
    var x = Math.min(Math.max(r.x + r.width / 2, 1), Math.max(1, v.vw - 1))
    var y = Math.min(Math.max(r.y + r.height / 2, 1), Math.max(1, v.vh - 1))
    // Something else (a modal, a cookie banner) would take the click.
    var hit = elementAt(x, y)
    if (!hit || (hit !== el && !el.contains(hit) && !(hit.contains && hit.contains(el)))) return { error: 'obscured' }
    return { x: Math.round(x), y: Math.round(y), vw: v.vw, vh: v.vh }
  }

  var actingUntil = 0

  function prepare(spec) {
    var s = spec || {}
    if (pageUrl() !== s.approvedUrl || loadId !== s.approvedLoadId) return fail('approved-page-changed')
    var ms = typeof s.ms === 'number' && s.ms > 0 ? Math.min(s.ms, 60000) : 1500
    actingUntil = now() + ms
    var kind = String(s.kind || '')
    var el = null
    if (s.ref) {
      el = elForRef(s.ref)
      if (!el) return fail('stale-ref')
    } else if (kind !== 'key' && kind !== 'scroll') {
      el = elementAt(s.x, s.y)
      if (!el) return fail('nothing-there')
    }
    if (el && s.expect && sigOf(el) !== s.expect) return fail('changed')
    var v = viewport()
    var base = { url: pageUrl(), loadId: loadId, vw: v.vw, vh: v.vh }

    if (kind === 'key') {
      var focused = document.activeElement
      if (PRINTABLE_KEY.test(String(s.key || '').split('+').pop()) && !/(^|\+)(Control|Meta)\+/.test(String(s.key || '')) && focused && sensitive(focused)) {
        return fail('sensitive-field')
      }
      base.x = 0
      base.y = 0
      return toJson(base)
    }

    if (kind === 'scroll') {
      var amount = typeof s.amount === 'number' && isFinite(s.amount) ? s.amount : Math.round((v.vh || 600) * 0.8)
      var dx = s.direction === 'left' ? -amount : s.direction === 'right' ? amount : 0
      var dy = s.direction === 'up' ? -amount : s.direction === 'down' ? amount : 0
      try {
        if (el && !s.direction) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        else if (el) el.scrollBy({ left: dx, top: dy, behavior: 'instant' })
        else window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
      } catch (_) {
        return fail('scroll-failed')
      }
      var after = viewport()
      base.done = true
      base.sx = after.sx
      base.sy = after.sy
      base.dh = after.dh
      return toJson(base)
    }

    if (!el) return fail('nothing-there')
    if (el.disabled || attr(el, 'aria-disabled') === 'true') return fail('disabled')

    if (kind === 'select') {
      if (el.tagName !== 'SELECT') return fail('not-a-select')
      var wanted = Array.isArray(s['values']) ? s['values'] : []
      if (!el.multiple && wanted.length > 1) return fail('not-multiple')
      var options = el.options || []
      var picks = []
      for (var w = 0; w < wanted.length; w++) {
        var want = String(wanted[w])
        var found = -1
        for (var pass = 0; pass < 2 && found < 0; pass++) {
          for (var o = 0; o < options.length; o++) {
            var opt = options[o]
            var val = attr(opt, 'value')
            var label = squash(opt.label || opt.text, 200)
            if (val === null) val = label
            var match = pass === 0 ? val === want || label === want : val.toLowerCase().trim() === want.toLowerCase().trim() || label.toLowerCase() === want.toLowerCase().trim()
            if (match && !opt.disabled) {
              found = o
              break
            }
          }
        }
        if (found < 0) return fail('no-such-option')
        picks.push(found)
      }
      if (el.multiple) {
        for (var m = 0; m < options.length; m++) options[m].selected = picks.indexOf(m) >= 0
      } else {
        el.selectedIndex = picks[0]
      }
      var point = pointFor(el)
      if (!point.error) ring(point.x, point.y)
      // A <select> popup is a native menu that would block the app, so the
      // choice is made here and announced the way the browser would.
      el.dispatchEvent(new window.Event('input', { bubbles: true }))
      el.dispatchEvent(new window.Event('change', { bubbles: true }))
      base.done = true
      base.selected = selectedLabels(el)
      return toJson(base)
    }

    if (kind === 'click' && el.tagName === 'SELECT') return fail('use-select')
    if (el.tagName === 'INPUT' && inputType(el) === 'file') return fail('file-input')
    if (kind === 'type') {
      if (!isTextField(el)) return fail('not-editable')
      if (el.readOnly) return fail('read-only')
      if (sensitive(el)) return fail('sensitive-field')
    }

    var p = pointFor(el)
    if (p.error) return fail(p.error)
    ring(p.x, p.y)
    base.x = p.x
    base.y = p.y
    base.vw = p.vw
    base.vh = p.vh
    if (kind === 'type') {
      base.multiline = el.tagName === 'TEXTAREA' || (!!el.isContentEditable && el.tagName !== 'INPUT')
      if (!s.clear) caretToEndAfterClick(el)
    }

    if (kind === 'click' && s.button === 'right') {
      // A native right click opens a native context menu, which blocks the
      // app until dismissed; pages with their own menus get the event.
      el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 2, buttons: 2 }))
      base.done = true
      base.synthetic = true
    }
    return toJson(base)
  }

  // Native focuses a field by clicking its centre, which would drop the caret
  // mid-text; once that click lands, put the caret at the end so typed text
  // is appended. setSelectionRange clamps to the end: the content is never read.
  function caretToEndAfterClick(el) {
    var armed = true
    function disarm() {
      armed = false
      try {
        el.removeEventListener('mouseup', onUp, true)
      } catch (_) {}
    }
    function onUp() {
      if (!armed) return
      disarm()
      setTimeout(function () {
        try {
          if (typeof el.setSelectionRange === 'function') {
            el.setSelectionRange(1e9, 1e9)
          } else if (el.isContentEditable) {
            var range = document.createRange()
            range.selectNodeContents(el)
            range.collapse(false)
            var sel = window.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)
          }
        } catch (_) {}
      }, 0)
    }
    try {
      el.addEventListener('mouseup', onUp, true)
      setTimeout(disarm, 2000)
    } catch (_) {}
  }

  // Select the field's existing content so native's Backspace replaces it.
  function clear(spec) {
    if (!spec || pageUrl() !== spec.approvedUrl || loadId !== spec.approvedLoadId) return fail('approved-page-changed')
    var el = spec && spec.ref ? elForRef(spec.ref) : document.activeElement
    if (!el) return fail('stale-ref')
    if (sensitive(el)) return fail('sensitive-field')
    try {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.select()
      } else if (el.isContentEditable) {
        var range = document.createRange()
        range.selectNodeContents(el)
        var sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      } else {
        return fail('not-editable')
      }
    } catch (_) {
      return fail('clear-failed')
    }
    return toJson({ ok: true })
  }

  function after(spec) {
    var s = spec || {}
    var out = { url: pageUrl(), title: pageTitle() }
    var el = s.ref ? elForRef(s.ref) : null
    try {
      if (s.kind === 'hover' && el) out.hovered = el.matches(':hover')
      var active = document.activeElement
      if (active && active !== document.body && active !== document.documentElement) out.focused = refFor(active)
    } catch (_) {}
    return toJson(out)
  }

  // Operator takeover is detected natively (only genuine input reaches the
  // app's event monitor); this stays for the protocol's `resume` query.
  function resume() {
    actingUntil = 0
    return toJson({ ok: true })
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
    var rect = rectOf(el)
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
    version: 2,
    dump: guard(dump),
    text: guard(text),
    info: guard(info),
    network: guard(network),
    snapshot: guard(snapshot),
    resolve: guard(resolve),
    prepare: guard(prepare),
    clear: guard(clear),
    after: guard(after),
    resume: guard(resume),
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
