//! Mason's personal lexicon (`lexicon serve`, 127.0.0.1:41733) from Rust.
//!
//! The Verse page never talks to it: the bearer token lives in
//! `~/.config/lexicon/serve.json` and a browser-origin call would need a CORS
//! entry. Native reads the token per request, sends it only to the loopback
//! port named in that same file, and never logs it or puts it in an error.
//!
//! - Final transcripts go through `POST /normalize {text, cwd}` (the chat's
//!   repo, so project lexicons apply). 900 ms budget.
//! - `GET /lexicon` is cached to `<app data>/voice/lexicon-cache.json`
//!   whenever the server answers; when it does not, the cached term map is
//!   applied locally (whole-word, case-insensitive alias → canonical) and the
//!   final is marked `cached` (the pill shows a quiet "raw" badge).
//! - Partials only ever use the in-memory cached map: no HTTP per partial.
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

/// `~/.config/lexicon/serve.json` → `(port, token)`.
#[derive(Deserialize)]
struct ServeConfig {
    port: Option<u16>,
    token: String,
}

pub fn default_serve_config_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config/lexicon/serve.json"))
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
    }
    let resp: Resp = serde_json::from_slice(body).ok()?;
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
    map: Mutex<Option<TermMap>>,
    refreshed: Mutex<Option<Instant>>,
    status: Mutex<LexiconStatus>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

impl Lexicon {
    pub fn new(serve_config: Option<PathBuf>, cache_path: PathBuf) -> Self {
        let map = std::fs::read(&cache_path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<TermMap>(&raw).ok());
        let status = if map.is_some() {
            LexiconStatus::Cached
        } else {
            LexiconStatus::None
        };
        Self {
            serve_config,
            cache_path,
            map: Mutex::new(map),
            refreshed: Mutex::new(None),
            status: Mutex::new(status),
        }
    }

    pub fn status(&self) -> LexiconStatus {
        *lock(&self.status)
    }

    fn config(&self) -> Option<(u16, String)> {
        read_serve_config(self.serve_config.as_deref()?)
    }

    /// Cheap, local, for partials.
    pub fn apply_cached(&self, text: &str) -> String {
        match lock(&self.map).as_ref() {
            Some(map) => apply_terms(text, map),
            None => text.to_string(),
        }
    }

    /// The final pass: live normalize, else the cached map.
    pub fn normalize(&self, text: &str, cwd: Option<&str>) -> (String, LexiconStatus) {
        if text.trim().is_empty() {
            return (text.to_string(), self.status());
        }
        if let Some((port, token)) = self.config() {
            // Latency: a normalize that APPLIES also records hits (a disk
            // write) — measured ~290 ms vs ~5-25 ms for a dry run. So the
            // final uses a dry run and applies the replacements here, and
            // the recording call runs afterwards, off the dictation path.
            let mut body = serde_json::json!({ "text": text, "dryRun": true });
            if let Some(cwd) = cwd {
                body["cwd"] = serde_json::Value::String(cwd.to_string());
            }
            if let Ok((200, raw)) = http(
                port,
                &token,
                "POST",
                "/normalize",
                Some(&body.to_string()),
                NORMALIZE_BUDGET,
            ) {
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
        let has_map = lock(&self.map).is_some();
        let status = if has_map {
            LexiconStatus::Cached
        } else {
            LexiconStatus::None
        };
        *lock(&self.status) = status;
        (self.apply_cached(text), status)
    }

    /// Refresh the cached term map from `GET /lexicon` if it is stale (or
    /// `force`). Returns the resulting status. Blocking — call off-thread.
    pub fn refresh(&self, cwd: Option<&str>, force: bool) -> LexiconStatus {
        let fresh = lock(&self.refreshed).is_some_and(|at| at.elapsed() < CACHE_REFRESH);
        if fresh && !force {
            return self.status();
        }
        let Some((port, token)) = self.config() else {
            return self.mark_unreachable();
        };
        let path = match cwd {
            Some(cwd) => format!("/lexicon?cwd={}", percent_encode(cwd)),
            None => "/lexicon".to_string(),
        };
        match http(port, &token, "GET", &path, None, FETCH_BUDGET) {
            Ok((200, raw)) => match term_map_from_lexicon_response(&raw) {
                Some(map) => {
                    if let Some(parent) = self.cache_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Ok(json) = serde_json::to_vec(&map) {
                        let tmp = self.cache_path.with_extension("json.tmp");
                        if std::fs::write(&tmp, json).is_ok() {
                            let _ = std::fs::rename(&tmp, &self.cache_path);
                        }
                    }
                    *lock(&self.map) = Some(map);
                    *lock(&self.refreshed) = Some(Instant::now());
                    *lock(&self.status) = LexiconStatus::Live;
                    LexiconStatus::Live
                }
                None => self.mark_unreachable(),
            },
            _ => self.mark_unreachable(),
        }
    }

    fn mark_unreachable(&self) -> LexiconStatus {
        let status = if lock(&self.map).is_some() {
            LexiconStatus::Cached
        } else {
            LexiconStatus::None
        };
        *lock(&self.status) = status;
        status
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
                },
                CachedTerm {
                    canonical: "Ashlr Verse".into(),
                    aliases: vec!["ashler verse".into()],
                    case_sensitive: false,
                },
                CachedTerm {
                    canonical: "Grok".into(),
                    aliases: vec!["GROC".into()],
                    case_sensitive: true,
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

    #[test]
    fn live_normalize_sends_the_token_and_cwd_and_caches_the_map() {
        let lexicon_body =
            r#"{"lexicon":{"version":1,"terms":[{"canonical":"Ashlr.AI","aliases":["Ashler"]}]}}"#;
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
        assert_eq!(lex.apply_cached("ashler"), "Ashlr.AI");

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
        std::fs::write(&cache, serde_json::to_vec(&map()).unwrap()).unwrap();
        // A port nothing listens on.
        let unused = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let cfg = dir.join("serve.json");
        std::fs::write(&cfg, format!(r#"{{"port":{unused},"token":"t"}}"#)).unwrap();
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
