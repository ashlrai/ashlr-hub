//! Mason's personal lexicon (`lexicon serve`, 127.0.0.1:41733) from Rust.
//!
//! The Verse page never talks to it: the bearer token lives in
//! Lexicon's `serve.json` and a browser-origin call would need a CORS
//! entry. Native reads the token per request, sends it only to the loopback
//! port named in that same file, and never logs it or puts it in an error.
//!
//! - Final transcripts go through `POST /normalize {text, cwd}` (the chat's
//!   repo, so project lexicons apply). 900 ms budget.
//! - `GET /lexicon` is cached to `<app data>/voice/lexicon-cache.json`
//!   whenever the server answers; when it does not, the cached term map is
//!   applied locally (whole-word, case-insensitive alias → canonical) and the
//!   final is marked `cached` (the pill shows a quiet "raw" badge).
//!   Only confirmed global terms are cached: project trust can change while
//!   the server is offline, so project corrections require live normalize.
//! - Partials only use a cached map for their exact cwd: no HTTP per partial.
//! - `GET /export/whisper-prompt` biases the whisper fallback.

use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use super::protocol::LexiconStatus;

pub const DEFAULT_PORT: u16 = 41733;
const NORMALIZE_BUDGET: Duration = Duration::from_millis(900);
const FETCH_BUDGET: Duration = Duration::from_secs(3);
/// Refresh the cached map at most this often.
const CACHE_REFRESH: Duration = Duration::from_secs(10 * 60);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Lexicon's `serve.json` → `(port, token)`.
#[derive(Deserialize)]
struct ServeConfig {
    port: Option<u16>,
    token: String,
}

pub fn default_serve_config_path() -> Option<PathBuf> {
    serve_config_path(
        std::env::var_os("LEXICON_PATH").as_deref(),
        std::env::var_os("XDG_CONFIG_HOME").as_deref(),
        std::env::var_os("HOME").as_deref(),
    )
}

fn serve_config_path(
    lexicon_path: Option<&std::ffi::OsStr>,
    config_home: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    // Lexicon places serve.json beside the global lexicon, including a
    // relative LEXICON_PATH override. Empty overrides fall through.
    if let Some(path) = lexicon_path.filter(|p| !p.is_empty()) {
        let path = Path::new(path);
        return Some(path.parent().unwrap_or(path).join("serve.json"));
    }
    // Lexicon trims XDG_CONFIG_HOME and ignores blank/relative values.
    if let Some(path) = config_home.and_then(|p| p.to_str()).map(str::trim) {
        if Path::new(path).is_absolute() {
            return Some(PathBuf::from(path).join("lexicon/serve.json"));
        }
    }
    home.map(|home| PathBuf::from(home).join(".config/lexicon/serve.json"))
}

fn read_serve_config(path: &Path) -> Option<(u16, String)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let cfg: ServeConfig = serde_json::from_str(&raw).ok()?;
    let token = cfg.token.trim().to_string();
    // A token is an opaque bearer string; refuse anything that could smuggle a
    // header line.
    if token.is_empty()
        || token.len() > 512
        || token.bytes().any(|b| b.is_ascii_control() || b == b' ')
    {
        return None;
    }
    Some((cfg.port.unwrap_or(DEFAULT_PORT), token))
}

// ── minimal HTTP/1.0 over loopback ───────────────────────────────────────────

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Decode `Transfer-Encoding: chunked` (lexicon serve is node:http, which
/// chunks when it does not know the length up front; HTTP/1.0 requests
/// normally avoid it, but a proxy or a future version might not).
fn dechunk(body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
        let size_line = std::str::from_utf8(&rest[..line_end]).ok()?;
        let size = usize::from_str_radix(size_line.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if rest.len() < size + 2 {
            return None;
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}

/// Split a raw HTTP response into `(status, body)`.
pub fn parse_response(raw: &[u8]) -> Option<(u16, Vec<u8>)> {
    let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..head_end]).ok()?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let body = &raw[head_end + 4..];
    let body = if chunked {
        dechunk(body)?
    } else {
        body.to_vec()
    };
    Some((status, body))
}

fn http(
    port: u16,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    budget: Duration,
) -> Result<(u16, Vec<u8>), &'static str> {
    let deadline = Instant::now() + budget;
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream =
        TcpStream::connect_timeout(&addr, budget).map_err(|_| "lexicon serve is not running")?;
    let left = || {
        deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1))
    };
    let _ = stream.set_write_timeout(Some(left()));
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "lexicon serve did not accept the request")?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        let _ = stream.set_read_timeout(Some(left()));
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > MAX_RESPONSE_BYTES {
                    return Err("lexicon serve answered too much");
                }
            }
            Err(_) => return Err("lexicon serve timed out"),
        }
        if Instant::now() >= deadline {
            return Err("lexicon serve timed out");
        }
    }
    parse_response(&raw).ok_or("lexicon serve answered garbage")
}

// ── the cached term map ──────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedTerm {
    pub canonical: String,
    pub aliases: Vec<String>,
    #[serde(default, rename = "caseSensitive")]
    pub case_sensitive: bool,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TermMap {
    pub terms: Vec<CachedTerm>,
}

/// `GET /lexicon` → `{ lexicon: { terms: [...] } }`.
fn term_map_from_lexicon_response(body: &[u8]) -> Option<TermMap> {
    #[derive(Deserialize)]
    struct Resp {
        lexicon: TermMap,
        #[serde(default, rename = "projectTrust")]
        project_trust: Option<String>,
        #[serde(default)]
        paths: std::collections::HashMap<String, String>,
    }
    let mut resp: Resp = serde_json::from_slice(body).ok()?;
    // Project entries can override globals and declare scope=global. Require
    // positive server provenance, rather than trusting a term's own scope.
    // Any project context (even untrusted/changed) remains live-only.
    let global_only = resp
        .paths
        .get("global")
        .is_some_and(|path| !path.is_empty())
        && !resp.paths.contains_key("project")
        && resp.project_trust.is_none();
    resp.lexicon
        .terms
        .retain(|term| global_only && term.scope.as_deref() == Some("global"));
    Some(resp.lexicon)
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

/// Replace aliases with canonicals, whole words only, longest alias first,
/// never inside `inline code` / ``` fences. A canonical is never re-matched.
pub fn apply_terms(text: &str, map: &TermMap) -> String {
    // (alias, lowercased alias, canonical, case-sensitive)
    let mut rules: Vec<(&str, String, &str, bool)> = map
        .terms
        .iter()
        .flat_map(|t| {
            t.aliases
                .iter()
                .filter(|a| !a.trim().is_empty() && a.as_str() != t.canonical)
                .map(move |a| {
                    (
                        a.as_str(),
                        a.to_ascii_lowercase(),
                        t.canonical.as_str(),
                        t.case_sensitive,
                    )
                })
        })
        .collect();
    rules.sort_by_key(|rule| std::cmp::Reverse(rule.0.len()));
    if rules.is_empty() {
        return text.to_string();
    }
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let lower_bytes = lower.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_code = false;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            in_code = !in_code;
            out.push('`');
            i += 1;
            continue;
        }
        let at_word_start = i == 0 || !is_word_byte(bytes[i - 1]);
        if !in_code && at_word_start {
            let hit = rules.iter().find(|(alias, alias_lower, _, cs)| {
                let n = alias.len();
                if i + n > bytes.len() || !text.is_char_boundary(i + n) {
                    return false;
                }
                let matches = if *cs {
                    &bytes[i..i + n] == alias.as_bytes()
                } else {
                    &lower_bytes[i..i + n] == alias_lower.as_bytes()
                };
                matches && (i + n == bytes.len() || !is_word_byte(bytes[i + n]))
            });
            if let Some((alias, _, canonical, _)) = hit {
                out.push_str(canonical);
                i += alias.len();
                continue;
            }
        }
        // Copy one whole UTF-8 character.
        let ch = text[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// One `/normalize` replacement. Offsets are JavaScript string offsets
/// (UTF-16 code units) into the ORIGINAL input.
#[derive(Debug, Deserialize)]
struct Replacement {
    start: usize,
    end: usize,
    replacement: String,
}

/// UTF-16 offset → byte offset in `text` (None if it falls inside a char or
/// past the end).
fn utf16_to_byte(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == offset {
            return Some(byte);
        }
        units += ch.len_utf16();
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(text.len())
}

/// Apply a dry-run `/normalize` answer to `text`. None if the answer does not
/// describe THIS text (then the caller falls back to the cached map).
pub(crate) fn apply_dry_run(text: &str, raw: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct Out {
        input: String,
        replacements: Vec<Replacement>,
    }
    let out: Out = serde_json::from_slice(raw).ok()?;
    if out.input != text {
        return None;
    }
    let mut spans = Vec::with_capacity(out.replacements.len());
    for r in &out.replacements {
        let (start, end) = (utf16_to_byte(text, r.start)?, utf16_to_byte(text, r.end)?);
        if start > end {
            return None;
        }
        spans.push((start, end, r.replacement.as_str()));
    }
    spans.sort_by_key(|span| std::cmp::Reverse(span.0));
    let mut result = text.to_string();
    let mut floor = usize::MAX;
    for (start, end, replacement) in spans {
        if end > floor {
            return None; // overlapping replacements: not ours to guess
        }
        result.replace_range(start..end, replacement);
        floor = start;
    }
    Some(result)
}

// ── the client ───────────────────────────────────────────────────────────────

pub struct Lexicon {
    serve_config: Option<PathBuf>,
    cache_path: PathBuf,
    cache: Mutex<Option<ScopedCache>>,
    status: Mutex<LexiconStatus>,
}

/// Old unscoped cache files cannot establish which project supplied their
/// terms. Require a versioned envelope and the config source on reload.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScopedCache {
    version: u8,
    cwd: Option<String>,
    serve_config: Option<PathBuf>,
    source_stamp: Option<ConfigStamp>,
    map: TermMap,
    #[serde(skip)]
    refreshed: Option<Instant>,
}

/// Config rotation invalidates fallback without persisting or hashing its
/// bearer. This detects ordinary rewrites/atomic replacements, not deliberate
/// tampering by a local user who can also edit the cache itself.
#[derive(PartialEq, Eq, Serialize, Deserialize)]
struct ConfigStamp {
    len: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

fn config_stamp(path: Option<&Path>) -> Option<ConfigStamp> {
    let metadata = std::fs::metadata(path?).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(ConfigStamp {
        len: metadata.len(),
        modified_secs: modified.as_secs(),
        modified_nanos: modified.subsec_nanos(),
    })
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

impl Lexicon {
    pub fn new(serve_config: Option<PathBuf>, cache_path: PathBuf) -> Self {
        let cache = std::fs::read(&cache_path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<ScopedCache>(&raw).ok())
            .filter(|cache| {
                cache.version == 1
                    && cache.serve_config == serve_config
                    && cache.source_stamp == config_stamp(serve_config.as_deref())
            })
            .map(|mut cache| {
                cache
                    .map
                    .terms
                    .retain(|term| term.scope.as_deref() == Some("global"));
                cache
            });
        let status = if cache
            .as_ref()
            .is_some_and(|cache| !cache.map.terms.is_empty())
        {
            LexiconStatus::Cached
        } else {
            LexiconStatus::None
        };
        Self {
            serve_config,
            cache_path,
            cache: Mutex::new(cache),
            status: Mutex::new(status),
        }
    }

    pub fn status(&self) -> LexiconStatus {
        *lock(&self.status)
    }

    fn config(&self) -> Option<(u16, String)> {
        read_serve_config(self.serve_config.as_deref()?)
    }

    fn cache_matches(&self, cache: &ScopedCache, cwd: Option<&str>) -> bool {
        cache.cwd.as_deref() == cwd
            && cache.source_stamp == config_stamp(self.serve_config.as_deref())
    }

    /// Cheap, local, for partials. Exact cwd matching deliberately avoids
    /// conflating symlinks or inferring project ancestry across trust scopes.
    pub fn apply_cached(&self, text: &str, cwd: Option<&str>) -> String {
        match lock(&self.cache)
            .as_ref()
            .filter(|cache| self.cache_matches(cache, cwd))
        {
            Some(cache) => apply_terms(text, &cache.map),
            None => text.to_string(),
        }
    }

    /// The final pass: live normalize, else the cached map.
    pub fn normalize(&self, text: &str, cwd: Option<&str>) -> (String, LexiconStatus) {
        if text.trim().is_empty() {
            return (text.to_string(), self.status());
        }
        let source_stamp = config_stamp(self.serve_config.as_deref());
        if let Some((port, token)) = self.config() {
            // Latency: a normalize that APPLIES also records hits (a disk
            // write) — measured ~290 ms vs ~5-25 ms for a dry run. So the
            // final uses a dry run and applies the replacements here, and
            // the recording call runs afterwards, off the dictation path.
            let mut body = serde_json::json!({ "text": text, "dryRun": true });
            if let Some(cwd) = cwd {
                body["cwd"] = serde_json::Value::String(cwd.to_string());
            }
            let answer = http(
                port,
                &token,
                "POST",
                "/normalize",
                Some(&body.to_string()),
                NORMALIZE_BUDGET,
            );
            if source_stamp != config_stamp(self.serve_config.as_deref()) {
                self.invalidate_cache();
                return (text.to_string(), LexiconStatus::None);
            }
            if matches!(answer, Ok((401 | 403, _))) {
                self.invalidate_cache();
            }
            if let Ok((200, raw)) = answer {
                if let Some(output) = apply_dry_run(text, &raw) {
                    *lock(&self.status) = LexiconStatus::Live;
                    if output != text {
                        body["dryRun"] = serde_json::Value::Bool(false);
                        let payload = body.to_string();
                        std::thread::spawn(move || {
                            let _ = http(
                                port,
                                &token,
                                "POST",
                                "/normalize",
                                Some(&payload),
                                FETCH_BUDGET,
                            );
                        });
                    }
                    return (output, LexiconStatus::Live);
                }
            }
        }
        let cache = lock(&self.cache);
        let cached = cache
            .as_ref()
            .filter(|cache| self.cache_matches(cache, cwd));
        let has_map = cached.is_some_and(|cache| !cache.map.terms.is_empty());
        let status = if has_map {
            LexiconStatus::Cached
        } else {
            LexiconStatus::None
        };
        *lock(&self.status) = status;
        let output = cached.map_or_else(|| text.to_string(), |cache| apply_terms(text, &cache.map));
        (output, status)
    }

    /// Refresh the cached term map from `GET /lexicon` if it is stale (or
    /// `force`). Returns the resulting status. Blocking — call off-thread.
    pub fn refresh(&self, cwd: Option<&str>, force: bool) -> LexiconStatus {
        let fresh = lock(&self.cache).as_ref().is_some_and(|cache| {
            self.cache_matches(cache, cwd)
                && cache
                    .refreshed
                    .is_some_and(|at| at.elapsed() < CACHE_REFRESH)
        });
        if fresh && !force {
            return self.status();
        }
        let source_stamp = config_stamp(self.serve_config.as_deref());
        let Some((port, token)) = self.config() else {
            return self.mark_unreachable(cwd);
        };
        let path = match cwd {
            Some(cwd) => format!("/lexicon?cwd={}", percent_encode(cwd)),
            None => "/lexicon".to_string(),
        };
        let answer = http(port, &token, "GET", &path, None, FETCH_BUDGET);
        if source_stamp != config_stamp(self.serve_config.as_deref()) {
            self.invalidate_cache();
            return LexiconStatus::None;
        }
        match answer {
            Ok((200, raw)) => match term_map_from_lexicon_response(&raw) {
                Some(map) => {
                    let cache = ScopedCache {
                        version: 1,
                        cwd: cwd.map(str::to_string),
                        serve_config: self.serve_config.clone(),
                        source_stamp,
                        map,
                        refreshed: Some(Instant::now()),
                    };
                    // Serialize persistence and publication under the same
                    // lock so concurrent refreshes cannot leave different
                    // scopes on disk and in memory or race the temp file.
                    let mut cached = lock(&self.cache);
                    if let Some(parent) = self.cache_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Ok(json) = serde_json::to_vec(&cache) {
                        let tmp = self.cache_path.with_extension("json.tmp");
                        if std::fs::write(&tmp, json).is_ok() {
                            let _ = std::fs::rename(&tmp, &self.cache_path);
                        }
                    }
                    *cached = Some(cache);
                    *lock(&self.status) = LexiconStatus::Live;
                    LexiconStatus::Live
                }
                None => self.mark_unreachable(cwd),
            },
            Ok((401 | 403, _)) => {
                self.invalidate_cache();
                LexiconStatus::None
            }
            _ => self.mark_unreachable(cwd),
        }
    }

    fn mark_unreachable(&self, cwd: Option<&str>) -> LexiconStatus {
        let status = if lock(&self.cache)
            .as_ref()
            .is_some_and(|cache| self.cache_matches(cache, cwd) && !cache.map.terms.is_empty())
        {
            LexiconStatus::Cached
        } else {
            LexiconStatus::None
        };
        *lock(&self.status) = status;
        status
    }

    fn invalidate_cache(&self) {
        let mut cache = lock(&self.cache);
        *cache = None;
        let _ = std::fs::remove_file(&self.cache_path);
        *lock(&self.status) = LexiconStatus::None;
    }

    /// `GET /export/whisper-prompt` — comma-separated canonicals for whisper's
    /// initial prompt, capped so it stays inside whisper's prompt window.
    pub fn whisper_prompt(&self, cwd: Option<&str>) -> Option<String> {
        let (port, token) = self.config()?;
        let path = match cwd {
            Some(cwd) => format!("/export/whisper-prompt?cwd={}", percent_encode(cwd)),
            None => "/export/whisper-prompt".to_string(),
        };
        match http(port, &token, "GET", &path, None, FETCH_BUDGET) {
            Ok((200, raw)) => {
                let text = String::from_utf8(raw).ok()?;
                let text: String = text.trim().chars().take(800).collect();
                (!text.is_empty()).then_some(text)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn map() -> TermMap {
        TermMap {
            terms: vec![
                CachedTerm {
                    canonical: "Ashlr.AI".into(),
                    aliases: vec!["Ashler".into(), "Ashlar".into(), "ash ler".into()],
                    case_sensitive: false,
                    scope: Some("global".into()),
                },
                CachedTerm {
                    canonical: "Ashlr Verse".into(),
                    aliases: vec!["ashler verse".into()],
                    case_sensitive: false,
                    scope: Some("global".into()),
                },
                CachedTerm {
                    canonical: "Grok".into(),
                    aliases: vec!["GROC".into()],
                    case_sensitive: true,
                    scope: Some("global".into()),
                },
            ],
        }
    }

    #[test]
    fn aliases_become_canonicals_longest_first_whole_words_only() {
        let m = map();
        assert_eq!(
            apply_terms("open ashler verse now", &m),
            "open Ashlr Verse now"
        );
        assert_eq!(
            apply_terms("Ashler and ASHLAR.", &m),
            "Ashlr.AI and Ashlr.AI."
        );
        assert_eq!(apply_terms("ash ler rocks", &m), "Ashlr.AI rocks");
        // Not inside a longer word.
        assert_eq!(apply_terms("ashlering", &m), "ashlering");
        assert_eq!(apply_terms("preashler", &m), "preashler");
        // Case-sensitive aliases only match exactly.
        assert_eq!(apply_terms("GROC and groc", &m), "Grok and groc");
        // Never inside inline code.
        assert_eq!(
            apply_terms("run `ashler` then ashler", &m),
            "run `ashler` then Ashlr.AI"
        );
        // Multi-byte text around matches survives.
        assert_eq!(apply_terms("café ashler — ok", &m), "café Ashlr.AI — ok");
        assert_eq!(apply_terms("", &m), "");
        assert_eq!(apply_terms("anything", &TermMap::default()), "anything");
    }

    #[test]
    fn dry_run_replacements_apply_by_utf16_offsets() {
        let raw = br#"{"input":"open ashler verse","output":"open ashler verse","replacements":[{"start":5,"end":17,"original":"ashler verse","replacement":"Ashlr Verse","canonical":"Ashlr Verse","reason":"alias","confidence":1}],"changed":false}"#;
        assert_eq!(
            apply_dry_run("open ashler verse", raw).as_deref(),
            Some("open Ashlr Verse")
        );
        // "é" is 1 UTF-16 unit but 2 bytes; "𝄞" is 2 units and 4 bytes.
        let text = "café 𝄞 ashler!";
        let raw = r#"{"input":"café 𝄞 ashler!","replacements":[{"start":8,"end":14,"replacement":"Ashlr.AI"}]}"#.as_bytes();
        assert_eq!(
            apply_dry_run(text, raw).as_deref(),
            Some("café 𝄞 Ashlr.AI!")
        );
        // Two replacements, applied right to left.
        let raw = br#"{"input":"a ashler b ashler","replacements":[{"start":2,"end":8,"replacement":"X"},{"start":11,"end":17,"replacement":"Y"}]}"#;
        assert_eq!(
            apply_dry_run("a ashler b ashler", raw).as_deref(),
            Some("a X b Y")
        );
        // An answer about different text, a split character or overlaps is refused.
        assert_eq!(apply_dry_run("other", raw), None);
        let split =
            r#"{"input":"𝄞","replacements":[{"start":1,"end":2,"replacement":"x"}]}"#.as_bytes();
        assert_eq!(apply_dry_run("𝄞", split), None);
        let overlap = br#"{"input":"abcdef","replacements":[{"start":0,"end":3,"replacement":"x"},{"start":2,"end":4,"replacement":"y"}]}"#;
        assert_eq!(apply_dry_run("abcdef", overlap), None);
    }

    #[test]
    fn http_responses_parse_plain_and_chunked() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"a\":1}";
        assert_eq!(parse_response(plain), Some((200, b"{\"a\":1}".to_vec())));
        let chunked =
            b"HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked), Some((401, b"{\"a\":1}".to_vec())));
        assert_eq!(parse_response(b"garbage"), None);
        assert_eq!(percent_encode("/Users/m/my repo"), "/Users/m/my%20repo");
    }

    #[test]
    fn serve_config_tokens_are_validated() {
        let dir = std::env::temp_dir().join(format!("ashlr-lex-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("serve.json");
        std::fs::write(&path, r#"{"port":5,"token":"abc"}"#).unwrap();
        assert_eq!(read_serve_config(&path), Some((5, "abc".into())));
        std::fs::write(&path, r#"{"token":"abc\r\nX-Evil: 1"}"#).unwrap();
        assert_eq!(read_serve_config(&path), None);
        std::fs::write(&path, r#"{"token":""}"#).unwrap();
        assert_eq!(read_serve_config(&path), None);
        std::fs::write(&path, r#"{"token":"t"}"#).unwrap();
        assert_eq!(read_serve_config(&path), Some((DEFAULT_PORT, "t".into())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A one-shot fake `lexicon serve`: answers each accepted connection with
    /// the next canned response and records the request it saw.
    fn fake_server(responses: Vec<String>) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for response in responses {
                let (mut sock, _) = listener.accept().unwrap();
                sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                // Read until the declared body has arrived.
                loop {
                    let n = sock.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    req.extend_from_slice(&buf[..n]);
                    if let Some(end) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&req[..end]).to_ascii_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if req.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                seen.push(String::from_utf8_lossy(&req).into_owned());
                sock.write_all(response.as_bytes()).unwrap();
            }
            seen
        });
        (port, handle)
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ashlr-lex-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_cache(path: &Path, cwd: Option<&str>, cfg: Option<&Path>) {
        let cache = ScopedCache {
            version: 1,
            cwd: cwd.map(str::to_string),
            serve_config: cfg.map(Path::to_path_buf),
            source_stamp: config_stamp(cfg),
            map: map(),
            refreshed: None,
        };
        std::fs::write(path, serde_json::to_vec(&cache).unwrap()).unwrap();
    }

    #[test]
    fn config_discovery_matches_lexicon_overrides() {
        use std::ffi::OsStr;
        let resolve = |lex: Option<&str>, xdg: Option<&str>, home: Option<&str>| {
            serve_config_path(
                lex.map(OsStr::new),
                xdg.map(OsStr::new),
                home.map(OsStr::new),
            )
        };
        assert_eq!(
            resolve(None, None, Some("/home/m")),
            Some("/home/m/.config/lexicon/serve.json".into())
        );
        assert_eq!(
            resolve(Some("/custom/words.yaml"), Some("/xdg"), None),
            Some("/custom/serve.json".into())
        );
        assert_eq!(
            resolve(Some("words.yaml"), Some("/xdg"), None),
            Some("serve.json".into())
        );
        assert_eq!(resolve(Some("/"), None, None), Some("/serve.json".into()));
        assert_eq!(
            resolve(Some(""), Some(" /xdg "), None),
            Some("/xdg/lexicon/serve.json".into())
        );
        for invalid in ["", "  ", "relative/config"] {
            assert_eq!(
                resolve(None, Some(invalid), Some("/home/m")),
                Some("/home/m/.config/lexicon/serve.json".into())
            );
        }
        assert_eq!(resolve(None, None, None), None);
    }

    #[test]
    fn only_confirmed_global_terms_without_a_project_merge_are_cacheable() {
        let raw = br#"{"paths":{"global":"/global/lexicon.yaml"},"lexicon":{"terms":[{"canonical":"Global","aliases":["g"],"scope":"global"},{"canonical":"Project","aliases":["p"],"scope":"project"},{"canonical":"Unknown","aliases":["u"]}]}}"#;
        let map = term_map_from_lexicon_response(raw).unwrap();
        assert_eq!(apply_terms("g p u", &map), "Global p u");
        let mut response: serde_json::Value = serde_json::from_slice(raw).unwrap();
        response["projectTrust"] = serde_json::json!("trusted");
        assert!(
            term_map_from_lexicon_response(&serde_json::to_vec(&response).unwrap())
                .unwrap()
                .terms
                .is_empty()
        );
        response["projectTrust"] = serde_json::Value::Null;
        response["paths"] = serde_json::json!({"project":"/project/.lexicon.yaml"});
        assert!(
            term_map_from_lexicon_response(&serde_json::to_vec(&response).unwrap())
                .unwrap()
                .terms
                .is_empty()
        );
        // A project term may spoof global scope. Response provenance still
        // excludes it, before and after trust changes.
        response["lexicon"]["terms"][1]["scope"] = serde_json::json!("global");
        for trust in ["trusted", "changed", "untrusted"] {
            response["projectTrust"] = serde_json::json!(trust);
            let map =
                term_map_from_lexicon_response(&serde_json::to_vec(&response).unwrap()).unwrap();
            assert_eq!(apply_terms("g p", &map), "g p");
        }
        response.as_object_mut().unwrap().remove("projectTrust");
        response.as_object_mut().unwrap().remove("paths");
        assert!(
            term_map_from_lexicon_response(&serde_json::to_vec(&response).unwrap())
                .unwrap()
                .terms
                .is_empty()
        );
    }

    #[test]
    fn authorization_failure_discards_memory_and_disk_cache() {
        for (status, refresh) in [(401, false), (403, true)] {
            let (port, server) =
                fake_server(vec![format!("HTTP/1.1 {status} Forbidden\r\n\r\n{{}}")]);
            let dir = scratch("revoked");
            let path = dir.join("cache.json");
            let cfg = dir.join("serve.json");
            std::fs::write(&cfg, format!(r#"{{"port":{port},"token":"t"}}"#)).unwrap();
            write_cache(&path, Some("/a"), Some(&cfg));
            let lex = Lexicon::new(Some(cfg.clone()), path.clone());
            assert_eq!(lex.apply_cached("ashler", Some("/a")), "Ashlr.AI");
            if refresh {
                assert_eq!(lex.refresh(Some("/a"), true), LexiconStatus::None);
            } else {
                assert_eq!(
                    lex.normalize("ashler", Some("/a")),
                    ("ashler".into(), LexiconStatus::None)
                );
            }
            server.join().unwrap();
            assert_eq!(lex.apply_cached("ashler", Some("/a")), "ashler");
            assert!(!path.exists());
            assert_eq!(Lexicon::new(Some(cfg), path).status(), LexiconStatus::None);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn trusted_project_normalizes_live_without_persisting_project_terms() {
        let response = r#"{"paths":{"global":"/global/lexicon.yaml","project":"/a/.lexicon.yaml"},"projectTrust":"trusted","lexicon":{"terms":[{"canonical":"ProjectSecretName","aliases":["project alias"],"scope":"global"}]}}"#;
        let normalized = r#"{"input":"project alias","replacements":[{"start":0,"end":13,"replacement":"ProjectSecretName"}]}"#;
        let (port, server) = fake_server(vec![
            format!("HTTP/1.1 200 OK\r\n\r\n{response}"),
            format!("HTTP/1.1 200 OK\r\n\r\n{normalized}"),
            "HTTP/1.1 200 OK\r\n\r\n{}".into(),
        ]);
        let dir = scratch("project-live");
        let cfg = dir.join("serve.json");
        let path = dir.join("cache.json");
        std::fs::write(&cfg, format!(r#"{{"port":{port},"token":"t"}}"#)).unwrap();
        let lex = Lexicon::new(Some(cfg.clone()), path.clone());
        assert_eq!(lex.refresh(Some("/a"), true), LexiconStatus::Live);
        assert_eq!(
            lex.apply_cached("project alias", Some("/a")),
            "project alias"
        );
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("ProjectSecretName"));
        assert_eq!(
            lex.normalize("project alias", Some("/a")),
            ("ProjectSecretName".into(), LexiconStatus::Live)
        );
        server.join().unwrap();
        let restored = Lexicon::new(Some(cfg), path);
        assert_eq!(
            restored.normalize("project alias", Some("/a")),
            ("project alias".into(), LexiconStatus::None)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn project_cache_never_corrects_another_project_or_unscoped_partials() {
        let dir = scratch("scope");
        let path = dir.join("cache.json");
        write_cache(&path, Some("/project/a"), None);
        let lex = Lexicon::new(None, path);
        assert_eq!(lex.apply_cached("ashler", Some("/project/a")), "Ashlr.AI");
        assert_eq!(
            lex.normalize("ashler", Some("/project/a")),
            ("Ashlr.AI".into(), LexiconStatus::Cached)
        );
        for cwd in [Some("/project/b"), Some("/project/a/subdir"), None] {
            assert_eq!(lex.apply_cached("ashler", cwd), "ashler");
            assert_eq!(
                lex.normalize("ashler", cwd),
                ("ashler".into(), LexiconStatus::None)
            );
            assert_eq!(lex.refresh(cwd, false), LexiconStatus::None);
        }
        // Switching away did not change the provenance of the surviving map.
        assert_eq!(lex.apply_cached("ashler", Some("/project/a")), "Ashlr.AI");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_or_wrong_config_cache_is_not_adopted() {
        let dir = scratch("migration");
        let path = dir.join("cache.json");
        std::fs::write(&path, serde_json::to_vec(&map()).unwrap()).unwrap();
        let lex = Lexicon::new(None, path.clone());
        assert_eq!(
            lex.normalize("ashler", None),
            ("ashler".into(), LexiconStatus::None)
        );
        write_cache(&path, None, Some(Path::new("/old/serve.json")));
        let lex = Lexicon::new(Some("/new/serve.json".into()), path.clone());
        assert_eq!(
            lex.normalize("ashler", None),
            ("ashler".into(), LexiconStatus::None)
        );
        let mut raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        raw["version"] = serde_json::json!(2);
        std::fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
        assert_eq!(
            Lexicon::new(Some("/old/serve.json".into()), path).status(),
            LexiconStatus::None
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn config_rotation_invalidates_partials_freshness_and_restart_fallback() {
        let dir = scratch("config-rotation");
        let cfg = dir.join("serve.json");
        let path = dir.join("cache.json");
        std::fs::write(&cfg, r#"{"port":1,"token":"old"}"#).unwrap();
        write_cache(&path, Some("/a"), Some(&cfg));
        let lex = Lexicon::new(Some(cfg.clone()), path.clone());
        lock(&lex.cache).as_mut().unwrap().refreshed = Some(Instant::now());
        assert_eq!(lex.apply_cached("ashler", Some("/a")), "Ashlr.AI");
        // Different size guarantees detection even on a coarse clock.
        std::fs::write(&cfg, r#"{"port":1,"token":"replacement"}"#).unwrap();
        assert_eq!(lex.apply_cached("ashler", Some("/a")), "ashler");
        assert_eq!(lex.refresh(Some("/a"), false), LexiconStatus::None);
        assert_eq!(
            lex.normalize("ashler", Some("/a")),
            ("ashler".into(), LexiconStatus::None)
        );
        let restored = Lexicon::new(Some(cfg.clone()), path);
        assert_eq!(restored.status(), LexiconStatus::None);
        std::fs::remove_file(cfg).unwrap();
        assert_eq!(lex.apply_cached("ashler", Some("/a")), "ashler");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn switching_projects_bypasses_freshness_and_persists_only_its_scope() {
        let response = |name: &str| {
            format!(
            "HTTP/1.1 200 OK\r\n\r\n{{\"paths\":{{\"global\":\"/global/lexicon.yaml\"}},\"lexicon\":{{\"terms\":[{{\"canonical\":\"{name}\",\"aliases\":[\"alias\"],\"scope\":\"global\"}}]}}}}"
        )
        };
        let (port, server) = fake_server(vec![response("ProjectA"), response("ProjectB")]);
        let dir = scratch("switch");
        let cfg = dir.join("serve.json");
        let path = dir.join("cache.json");
        std::fs::write(&cfg, format!(r#"{{"port":{port},"token":"t"}}"#)).unwrap();
        let lex = Lexicon::new(Some(cfg.clone()), path.clone());
        assert_eq!(lex.refresh(Some("/a"), false), LexiconStatus::Live);
        assert_eq!(lex.refresh(Some("/a"), false), LexiconStatus::Live);
        assert_eq!(lex.apply_cached("alias", Some("/a")), "ProjectA");
        assert_eq!(lex.refresh(Some("/b"), false), LexiconStatus::Live);
        let seen = server.join().unwrap();
        assert_eq!(
            seen.len(),
            2,
            "same scope reuses freshness; different scope fetches"
        );
        assert!(seen[1].starts_with("GET /lexicon?cwd=/b "));
        assert_eq!(lex.apply_cached("alias", Some("/a")), "alias");
        assert_eq!(lex.apply_cached("alias", Some("/b")), "ProjectB");
        // The server has exited. Reloaded cache still respects the project.
        let restored = Lexicon::new(Some(cfg), path);
        assert_eq!(
            restored.normalize("alias", Some("/a")),
            ("alias".into(), LexiconStatus::None)
        );
        assert_eq!(
            restored.normalize("alias", Some("/b")),
            ("ProjectB".into(), LexiconStatus::Cached)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn live_normalize_sends_the_token_and_cwd_and_caches_the_map() {
        let lexicon_body = r#"{"paths":{"global":"/global/lexicon.yaml"},"lexicon":{"version":1,"terms":[{"canonical":"Ashlr.AI","aliases":["Ashler"],"scope":"global"}]}}"#;
        let normalize_body = r#"{"input":"hi ashler","output":"hi ashler","replacements":[{"start":3,"end":9,"replacement":"Ashlr.AI"}],"changed":false}"#;
        let (port, server) = fake_server(vec![
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{lexicon_body}"),
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{normalize_body}"),
            // The hit-recording call, off the dictation path.
            "HTTP/1.1 200 OK\r\n\r\n{}".to_string(),
        ]);
        let dir = scratch("live");
        let cfg = dir.join("serve.json");
        std::fs::write(&cfg, format!(r#"{{"port":{port},"token":"s3cret"}}"#)).unwrap();
        let cache = dir.join("voice").join("lexicon-cache.json");
        let lex = Lexicon::new(Some(cfg), cache.clone());
        assert_eq!(lex.status(), LexiconStatus::None);

        assert_eq!(
            lex.refresh(Some("/Users/m/my repo"), true),
            LexiconStatus::Live
        );
        assert!(
            cache.exists(),
            "the term map is cached for when serve is down"
        );
        assert_eq!(
            lex.apply_cached("ashler", Some("/Users/m/my repo")),
            "Ashlr.AI"
        );

        let (text, status) = lex.normalize("hi ashler", Some("/Users/m/repo"));
        assert_eq!(
            (text.as_str(), status),
            ("hi Ashlr.AI", LexiconStatus::Live)
        );

        let seen = server.join().unwrap();
        assert!(
            seen[0].starts_with("GET /lexicon?cwd=/Users/m/my%20repo HTTP/1.0\r\n"),
            "{}",
            seen[0]
        );
        assert!(seen[0].contains("Authorization: Bearer s3cret\r\n"));
        assert!(seen[1].starts_with("POST /normalize HTTP/1.0\r\n"));
        let body = &seen[1][seen[1].find("\r\n\r\n").unwrap() + 4..];
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(
            body,
            serde_json::json!({ "text": "hi ashler", "cwd": "/Users/m/repo", "dryRun": true })
        );
        let record = &seen[2][seen[2].find("\r\n\r\n").unwrap() + 4..];
        let record: serde_json::Value = serde_json::from_str(record).unwrap();
        assert_eq!(
            record["dryRun"], false,
            "hits are still recorded, afterwards"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn when_serve_is_down_the_cached_map_applies_and_says_so() {
        let dir = scratch("down");
        let cache = dir.join("lexicon-cache.json");
        // A port nothing listens on.
        let unused = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let cfg = dir.join("serve.json");
        std::fs::write(&cfg, format!(r#"{{"port":{unused},"token":"t"}}"#)).unwrap();
        write_cache(&cache, None, Some(&cfg));
        let lex = Lexicon::new(Some(cfg), cache);
        let (text, status) = lex.normalize("open ashler verse", None);
        assert_eq!(text, "open Ashlr Verse");
        assert_eq!(status, LexiconStatus::Cached);
        assert_eq!(lex.refresh(None, true), LexiconStatus::Cached);

        // No config and no cache at all: the words pass through untouched.
        let bare = Lexicon::new(None, dir.join("missing.json"));
        assert_eq!(
            bare.normalize("ashler", None),
            ("ashler".to_string(), LexiconStatus::None)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_401_or_garbage_falls_back_without_leaking_the_token() {
        let (port, server) = fake_server(vec![
            "HTTP/1.1 401 Unauthorized\r\n\r\n{\"error\":\"bad token\"}".into(),
        ]);
        let dir = scratch("401");
        let cfg = dir.join("serve.json");
        std::fs::write(&cfg, format!(r#"{{"port":{port},"token":"tok-xyz"}}"#)).unwrap();
        let lex = Lexicon::new(Some(cfg), dir.join("c.json"));
        let (text, status) = lex.normalize("hello", None);
        assert_eq!((text.as_str(), status), ("hello", LexiconStatus::None));
        server.join().unwrap();
        // Every error string the client can produce is token-free by
        // construction (static strings).
        let e = http(1, "tok-xyz", "GET", "/", None, Duration::from_millis(50)).unwrap_err();
        assert!(!e.contains("tok-xyz"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
