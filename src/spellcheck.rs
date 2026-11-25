//! Spell and grammar check with a LanguageTool server (docs/API.md → Spell check, #57) and the
//! project dictionary.
//!
//! [`annotate`] turns LaTeX into LanguageTool's AnnotatedText: prose is `text`, everything else
//! (commands, options, math, comments, verbatim, arguments that are keys or paths) is `markup`,
//! optionally read as `interpretAs`. The parts together are exactly the input, and LanguageTool
//! counts its offsets in UTF-16 over text *and* markup, so they are offsets into the input.

use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    ops::Range,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use oauth2::reqwest;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{
    anonymize::{
        arg_space, control_word, group_len as full_group_len, math_len, options as full_options,
        ARG_ENVS, DEFINE, KEEP, MATH, SECTION_LIKE,
    },
    comments, compile, detect,
    error::ApiError,
    projects::{Access, Role},
    workspace::Workspace,
    AppState,
};

/// Largest text checked per request (bytes).
pub const MAX_TEXT: usize = 100 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
/// Requests per user: at most this many at once, and per minute.
const PARALLEL: usize = 2;
const PER_MINUTE: u32 = 60;
const MAX_REPLACEMENTS: usize = 5;
const MAX_WORDS: i64 = 10_000;
const MAX_WORD: usize = 100;
const MAX_RULES: usize = 200;
/// Environments whose body is code, besides the verbatim ones.
/// A group or option that is not closed within this many bytes (or before a blank line) is
/// treated as unclosed: without the bound every unclosed `[`/`{` scans to the end, which is
/// quadratic for hostile input. Real arguments are short.
const GROUP_SCAN: usize = 2048;

/// `t` up to the first blank line or `GROUP_SCAN` bytes.
fn window(t: &str) -> &str {
    let mut end = t.len().min(GROUP_SCAN);
    while !t.is_char_boundary(end) {
        end -= 1;
    }
    let t = &t[..end];
    &t[..t.find("\n\n").unwrap_or(t.len())]
}

fn group_len(t: &str, open: char, close: char) -> Option<usize> {
    full_group_len(window(t), open, close)
}

fn options(tail: &str, out: &mut String) -> usize {
    full_options(window(tail), out)
}

const CODE_ENVS: &[&str] = &["tikzpicture", "forest", "dot2tex"];

// --- LaTeX → AnnotatedText ---

/// `(markup, byte range of the input, interpretAs)`; adjacent parts of one kind are merged.
#[derive(Default)]
struct Parts(Vec<(bool, Range<usize>, String)>);

impl Parts {
    fn push(&mut self, markup: bool, r: Range<usize>, interpret: &str) {
        if r.is_empty() && interpret.is_empty() {
            return;
        }
        if let Some((m, last, i)) = self.0.last_mut() {
            if *m == markup && last.end == r.start {
                last.end = r.end;
                i.push_str(interpret);
                return;
            }
        }
        self.0.push((markup, r, interpret.to_owned()));
    }
}

/// LaTeX source as LanguageTool AnnotatedText (see the module docs).
pub struct Annotated<'a> {
    src: &'a str,
    parts: Parts,
}

impl Annotated<'_> {
    /// The `data` parameter of `/v2/check`.
    pub fn json(&self) -> String {
        let parts: Vec<_> = (self.parts.0.iter())
            .map(
                |(markup, r, interpret)| match (markup, interpret.is_empty()) {
                    (false, _) => json!({ "text": &self.src[r.clone()] }),
                    (true, true) => json!({ "markup": &self.src[r.clone()] }),
                    (true, false) => {
                        json!({ "markup": &self.src[r.clone()], "interpretAs": interpret })
                    }
                },
            )
            .collect();
        json!({ "annotation": parts }).to_string()
    }

    /// What LanguageTool checks: the text with markup replaced by its `interpretAs`.
    #[cfg(test)]
    fn seen(&self) -> String {
        (self.parts.0.iter())
            .map(|(markup, r, i)| {
                if *markup {
                    i.as_str()
                } else {
                    &self.src[r.clone()]
                }
            })
            .collect()
    }
}

pub fn annotate(src: &str) -> Annotated<'_> {
    let mut parts = Parts::default();
    // the preamble is code
    let mut i = document_start(src).unwrap_or(0);
    parts.push(true, 0..i, "");
    // closing `}` of headings: a paragraph break like the opening
    let mut closers: Vec<usize> = Vec::new();
    while let Some(c) = src[i..].chars().next() {
        while closers.last().is_some_and(|&e| e < i) {
            closers.pop();
        }
        if let Some((n, close)) = heading(&src[i..]) {
            closers.push(i + close);
            parts.push(true, i..i + n, "\n\n");
            i += n;
            continue;
        }
        let found = if closers.last() == Some(&i) {
            closers.pop();
            m(1, "\n\n")
        } else {
            markup(src, i)
        };
        match found {
            Some((n, interpret)) => {
                parts.push(true, i..i + n, &interpret);
                i += n;
            }
            None => {
                parts.push(false, i..i + c.len_utf8(), "");
                i += c.len_utf8();
            }
        }
    }
    Annotated { src, parts }
}

/// `\section*[…]{` (also `\chapter`, `\caption`, …): its length and the offset of its `}`.
fn heading(rest: &str) -> Option<(usize, usize)> {
    let n = control_word(rest);
    if n == 0 || &rest[1..n] == "item" || !SECTION_LIKE.contains(&&rest[1..n]) {
        return None;
    }
    let mut len = n + usize::from(rest[n..].starts_with('*'));
    len += options(&rest[len..], &mut String::new());
    len += arg_space(&rest[len..]);
    let g = group_len(&rest[len..], '{', '}')?;
    Some((len + 1, len + g - 1))
}

/// End of `\begin{document}` (outside comments).
fn document_start(src: &str) -> Option<usize> {
    const BEGIN: &str = r"\begin{document}";
    let mut offset = 0;
    for line in src.split_inclusive('\n') {
        if let Some(k) = detect::uncommented_line(line).find(BEGIN) {
            return Some(offset + k + BEGIN.len());
        }
        offset += line.len();
    }
    None
}

type Markup = Option<(usize, Cow<'static, str>)>;

fn m(n: usize, interpret: &'static str) -> Markup {
    Some((n, Cow::Borrowed(interpret)))
}

/// Markup starting at byte `i` of `src`: `(length, interpretAs)`; `None` = a text character.
fn markup(src: &str, i: usize) -> Markup {
    let rest = &src[i..];
    match rest.chars().next()? {
        '%' => {
            let eol = rest.find('\n').unwrap_or(rest.len());
            // a comment-only line goes with its line break, a trailing comment leaves it
            let own_line = src[..i].rsplit('\n').next().unwrap_or("").trim().is_empty();
            m(
                if own_line && eol < rest.len() {
                    eol + 1
                } else {
                    eol
                },
                "",
            )
        }
        '\\' => command(rest),
        '$' => {
            let n = math_len(rest);
            // an unclosed `$` is a character
            (n > if rest.starts_with("$$") { 2 } else { 1 }).then_some((n, "X".into()))
        }
        '~' => m(1, " "),
        '{' | '}' => m(1, ""),
        '-' if rest.starts_with("---") => m(3, "—"),
        '-' if rest.starts_with("--") => m(2, "–"),
        '`' if rest.starts_with("``") => m(2, "\""),
        '\'' if rest.starts_with("''") => m(2, "\""),
        _ => None,
    }
}

/// `rest` starts with `\`.
fn command(rest: &str) -> Markup {
    let n = control_word(rest);
    if n == 0 {
        return control_symbol(rest);
    }
    let name = &rest[1..n];
    let mut len = n + usize::from(rest[n..].starts_with('*'));
    let opts = |t: &str| options(t, &mut String::new());
    match name {
        "verb" => {
            // `\verb<d>…<d>`, unterminated: to the end of the line
            let body = &rest[len..];
            let Some(d) = body.chars().next().filter(|c| !c.is_whitespace()) else {
                return m(len, "");
            };
            let eol = body.find('\n').unwrap_or(body.len());
            let end = body[d.len_utf8()..eol]
                .find(d)
                .map_or(eol, |k| d.len_utf8() + k + d.len_utf8());
            m(len + end, "X")
        }
        "begin" => begin(rest, len),
        "end" => m(len + args(&rest[len..], 1), ""),
        "item" => m(len + opts(&rest[len..]), "\n\n"),
        "par" => m(len, "\n\n"),
        "newline" | "linebreak" => m(len, "\n"),
        "ss" => m(len + spaces(&rest[len..]), "ß"),
        "dots" | "ldots" | "textellipsis" => m(len, "…"),
        "LaTeX" | "LaTeXe" => m(len, "LaTeX"),
        "TeX" => m(len, "TeX"),
        "glqq" => m(len + spaces(&rest[len..]), "„"),
        "grqq" => m(len, "“"),
        "c" => accent(rest, len, 'c'),
        _ if DEFINE.contains(&name) => m(len + args(&rest[len..], 2), ""),
        _ => {
            len += opts(&rest[len..]);
            match KEEP.iter().find(|(k, _)| *k == name) {
                Some(&(_, n)) => m(len + args(&rest[len..], n), keep_reads_as(name)),
                // the arguments of any other command are text (`\section`, `\emph`, `\footnote`)
                None => m(len, ""),
            }
        }
    }
}

/// What a command with kept arguments prints, roughly (so the sentence around stays a sentence).
fn keep_reads_as(name: &str) -> &'static str {
    if name.ends_with("ref") && name != "href" || name == "crefrange" {
        "1"
    } else if name.contains("cite") && name != "nocite" {
        "[1]"
    } else if name == "url"
        || ["gls", "Gls", "GLS", "acr", "ac", "Ac"]
            .iter()
            .any(|p| name.starts_with(p))
    {
        "X"
    } else {
        ""
    }
}

/// Up to `n` `{…}` arguments (with options and single line breaks between): their length.
fn args(t: &str, n: usize) -> usize {
    let mut used = 0;
    for _ in 0..n {
        let ws = arg_space(&t[used..]);
        let o = options(&t[used + ws..], &mut String::new());
        let Some(g) = group_len(&t[used + ws + o..], '{', '}') else {
            break;
        };
        used += ws + o + g;
    }
    used
}

fn spaces(t: &str) -> usize {
    t.find(|c| c != ' ' && c != '\t').unwrap_or(t.len())
}

/// `\begin{env}` at `rest`, `len` past `\begin`.
fn begin(rest: &str, len: usize) -> Markup {
    let ws = arg_space(&rest[len..]);
    let Some(g) = group_len(&rest[len + ws..], '{', '}') else {
        return m(len, "");
    };
    let env = rest[len + ws + 1..len + ws + g - 1].trim();
    let head = len + ws + g;
    let code = crate::anonymize::VERBATIM.contains(&env)
        || detect::VERBATIM.contains(&env)
        || CODE_ENVS.contains(&env);
    if code || MATH.contains(&env) {
        let end = format!("\\end{{{env}}}");
        let n = rest[head..]
            .find(&end)
            .map_or(rest.len(), |k| head + k + end.len());
        return m(n, if code { "" } else { "X" });
    }
    let mut n = head + options(&rest[head..], &mut String::new());
    if ARG_ENVS.contains(&env) {
        const TWO: &[&str] = &[
            "tabular*",
            "tabularx",
            "tabulary",
            "xltabular",
            "wrapfigure",
            "wraptable",
        ];
        n += args(&rest[n..], if TWO.contains(&env) { 2 } else { 1 });
    }
    m(n, "")
}

/// `rest` = `\` + a non-letter.
fn control_symbol(rest: &str) -> Markup {
    let Some(c) = rest[1..].chars().next() else {
        return m(1, "");
    };
    let n = 1 + c.len_utf8();
    let until = |close: &str| {
        rest[2..]
            .find(close)
            .map_or(rest.len(), |k| 2 + k + close.len())
    };
    match c {
        '\\' => {
            let mut len = n + usize::from(rest[n..].starts_with('*'));
            len += options(&rest[len..], &mut String::new());
            m(len, "\n")
        }
        ',' | ';' | ':' | '>' | ' ' | '\n' => m(n, " "),
        '%' | '&' | '$' | '#' | '_' | '{' | '}' => Some((n, c.to_string().into())),
        '(' => m(until(r"\)"), "X"),
        '[' => m(until(r"\]"), "X"),
        '"' | '\'' | '`' | '^' | '~' | '=' | '.' => accent(rest, n, c),
        // `\-` `\/` `\!` `\@` and the rest print nothing
        _ => m(n, ""),
    }
}

/// `\"a` / `\"{a}` (`len` = length of `\"`) → `ä`; unknown accents keep the letter.
fn accent(rest: &str, len: usize, accent: char) -> Markup {
    let after = &rest[len..];
    let (letter, n) = match group_len(after, '{', '}') {
        Some(g) => (after[1..g - 1].trim().chars().next(), g),
        None => {
            let ws = if accent == 'c' { spaces(after) } else { 0 };
            let l = after[ws..].chars().next().filter(|c| c.is_alphabetic());
            (l, ws + l.map_or(0, char::len_utf8))
        }
    };
    let Some(l) = letter else {
        return m(len, "");
    };
    let out = compose(accent, l).unwrap_or(l);
    Some((len + n, out.to_string().into()))
}

fn compose(accent: char, l: char) -> Option<char> {
    let (from, to) = match accent {
        '"' => ("aouAOUeiyEI", "äöüÄÖÜëïÿËÏ"),
        '\'' => ("aeiouyAEIOUcnszCNSZ", "áéíóúýÁÉÍÓÚćńśźĆŃŚŹ"),
        '`' => ("aeiouAEIOU", "àèìòùÀÈÌÒÙ"),
        '^' => ("aeiouAEIOU", "âêîôûÂÊÎÔÛ"),
        '~' => ("anoANO", "ãñõÃÑÕ"),
        'c' => ("cCsS", "çÇşŞ"),
        _ => return None,
    };
    from.chars()
        .position(|f| f == l)
        .and_then(|k| to.chars().nth(k))
}

// --- LanguageTool client ---

/// `UNDERTREE_LANGUAGETOOL_URL` is set: the check is on.
pub struct LanguageTool {
    url: String,
    http: reqwest::Client,
    users: Mutex<HashMap<i64, Budget>>,
}

struct Budget {
    busy: Arc<Semaphore>,
    window: Instant,
    count: u32,
}

impl LanguageTool {
    pub fn new(url: &str) -> Result<Self, reqwest::Error> {
        Ok(Self {
            url: url.trim_end_matches('/').to_owned(),
            http: reqwest::Client::builder().timeout(TIMEOUT).build()?,
            users: Mutex::default(),
        })
    }

    /// One request of `user`, or 429 when too many run or ran in the last minute.
    fn admit(&self, user: i64) -> Result<OwnedSemaphorePermit, ApiError> {
        let mut users = self.users.lock().unwrap();
        let b = users.entry(user).or_insert_with(|| Budget {
            busy: Arc::new(Semaphore::new(PARALLEL)),
            window: Instant::now(),
            count: 0,
        });
        if b.window.elapsed() >= Duration::from_secs(60) {
            (b.window, b.count) = (Instant::now(), 0);
        }
        b.count += 1;
        let limited = || {
            ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "too many spell-check requests, try again shortly",
            )
        };
        if b.count > PER_MINUTE {
            return Err(limited());
        }
        b.busy.clone().try_acquire_owned().map_err(|_| limited())
    }
}

#[derive(Deserialize)]
struct LtResponse {
    matches: Vec<LtMatch>,
}

#[derive(Deserialize)]
struct LtMatch {
    message: String,
    #[serde(default, rename = "shortMessage")]
    short: String,
    #[serde(default)]
    replacements: Vec<LtValue>,
    offset: u32,
    length: u32,
    rule: LtRule,
}

#[derive(Deserialize)]
struct LtValue {
    value: String,
}

#[derive(Deserialize)]
struct LtRule {
    id: String,
    category: LtCategory,
}

#[derive(Deserialize)]
struct LtCategory {
    id: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Issue {
    start: u32,
    end: u32,
    message: String,
    short: String,
    rule: String,
    category: String,
    replacements: Vec<String>,
}

/// In the dictionary as written, or in lowercase (a dictionary `foo` accepts `Foo`).
fn known(dict: &HashSet<String>, word: &str) -> bool {
    dict.contains(word) || dict.contains(&word.to_lowercase())
}

/// LanguageTool matches on `text` (which starts at UTF-16 offset `start` of the file) as issues
/// in file offsets, without spelling matches on dictionary words.
fn issues(text: &str, start: u32, matches: Vec<LtMatch>, dict: &HashSet<String>) -> Vec<Issue> {
    (matches.into_iter())
        .filter(|m| {
            let word = comments::slice16(text, m.offset, m.offset + m.length);
            !(m.rule.category.id == "TYPOS" && word.is_some_and(|w| known(dict, w)))
        })
        .map(|m| Issue {
            start: start.saturating_add(m.offset),
            end: start.saturating_add(m.offset).saturating_add(m.length),
            message: m.message,
            short: m.short,
            rule: m.rule.id,
            category: m.rule.category.id,
            replacements: (m.replacements.into_iter())
                .take(MAX_REPLACEMENTS)
                .map(|r| r.value)
                .collect(),
        })
        .collect()
}

/// The `/v2/check` form for LaTeX `text`.
fn lt_form(text: &str, language: String, rules: Vec<String>) -> [(&'static str, String); 4] {
    // TeX collapses spaces, so repeated ones are never a mistake
    let disabled: Vec<String> = ["WHITESPACE_RULE".to_owned()]
        .into_iter()
        .chain(rules)
        .collect();
    [
        ("data", annotate(text).json()),
        ("language", language),
        ("level", "default".to_owned()),
        ("disabledRules", disabled.join(",")),
    ]
}

fn unavailable(msg: impl std::fmt::Display) -> ApiError {
    tracing::warn!("LanguageTool: {msg}");
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "spellcheck_unavailable",
        "the spell-check server is not reachable",
    )
}

// --- Routes ---

#[derive(Deserialize)]
pub struct CheckRequest {
    path: String,
    text: Option<String>,
    start: Option<u32>,
    language: Option<String>,
}

pub async fn check(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<CheckRequest>,
) -> Result<Json<Vec<Issue>>, ApiError> {
    let lt = app.languagetool.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "spellcheck_disabled",
            "spell check is not configured on this server",
        )
    })?;
    let p = app.runtime(access.info.id).await?;
    p.workspace.resolve(&b.path)?;
    if Workspace::in_uninitialized(&p.workspace.repos().await, &b.path) {
        return Err(ApiError::invalid_path(&b.path));
    }
    if let Some(l) = &b.language {
        let ok = l.len() <= 20 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !ok || l.is_empty() {
            return Err(ApiError::bad_request(
                "language must be a code such as de-DE",
            ));
        }
    }
    let _permit = lt.admit(access.user.id)?;
    // the whole file: to check, or for its `% !TeX spellcheck` comment
    let file = match (&b.text, &b.language) {
        (Some(_), Some(_)) => None,
        _ => Some(match p.docs.get(&b.path) {
            Some(room) => room.text(),
            None => comments::disk_text(&p, &b.path)?,
        }),
    };
    let magic = file.as_deref().and_then(detect::spell_magic);
    let (text, start) = match (b.text, file) {
        (Some(t), _) => (t, b.start.unwrap_or(0)),
        (None, f) => (f.unwrap_or_default(), 0),
    };
    if text.len() > MAX_TEXT {
        return Err(ApiError::too_large(format!(
            "at most {MAX_TEXT} bytes per request"
        )));
    }
    let language = match b.language.or(magic) {
        Some(l) => l,
        None => compile::language_of(&p, &b.path).await?,
    };
    let (words, rules) = settings(&app, access.info.id).await?;

    // the conversion is CPU work: off the async workers
    let (form, text) = tokio::task::spawn_blocking(move || (lt_form(&text, language, rules), text))
        .await
        .map_err(ApiError::internal)?;
    let res = (lt.http.post(format!("{}/v2/check", lt.url)))
        .form(&form)
        .send()
        .await
        .map_err(|e| unavailable(e.without_url()))?;
    let status = res.status();
    let body = res
        .bytes()
        .await
        .map_err(|e| unavailable(e.without_url()))?;
    if status.is_client_error() {
        // e.g. an unknown language code
        tracing::warn!(
            "LanguageTool {status}: {}",
            String::from_utf8_lossy(&body[..body.len().min(300)]).trim()
        );
        return Err(ApiError::bad_request(
            "LanguageTool rejected the request (unsupported language?)",
        ));
    }
    if !status.is_success() {
        return Err(unavailable(format!("HTTP {status}")));
    }
    let res: LtResponse = serde_json::from_slice(&body).map_err(unavailable)?;
    let dict: HashSet<String> = words.into_iter().collect();
    Ok(Json(issues(&text, start, res.matches, &dict)))
}

/// The project's dictionary words (sorted) and disabled LanguageTool rules.
async fn settings(app: &AppState, pid: i64) -> Result<(Vec<String>, Vec<String>), ApiError> {
    let words = sqlx::query_scalar(
        "SELECT word FROM project_dictionary WHERE project_id = ? ORDER BY word",
    )
    .bind(pid)
    .fetch_all(&app.db)
    .await
    .map_err(ApiError::internal)?;
    let rules: String =
        sqlx::query_scalar("SELECT spellcheck_disabled_rules FROM projects WHERE id = ?")
            .bind(pid)
            .fetch_one(&app.db)
            .await
            .map_err(ApiError::internal)?;
    Ok((words, serde_json::from_str(&rules).unwrap_or_default()))
}

#[derive(Serialize)]
pub struct Dictionary {
    words: Vec<String>,
    disabled_rules: Vec<String>,
}

pub async fn dictionary(
    State(app): State<Arc<AppState>>,
    access: Access,
) -> Result<Json<Dictionary>, ApiError> {
    let (words, disabled_rules) = settings(&app, access.info.id).await?;
    Ok(Json(Dictionary {
        words,
        disabled_rules,
    }))
}

#[derive(Deserialize)]
pub struct NewWord {
    word: String,
}

pub async fn add_word(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<NewWord>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Editor)?;
    let word = b.word.trim();
    if word.is_empty()
        || word.chars().count() > MAX_WORD
        || word
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '/')
        || word.chars().all(|c| c == '.')
    {
        return Err(ApiError::bad_request(format!(
            "word must have 1 to {MAX_WORD} characters, no spaces or slashes, not only dots"
        )));
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM project_dictionary WHERE project_id = ?")
            .bind(access.info.id)
            .fetch_one(&app.db)
            .await
            .map_err(ApiError::internal)?;
    if count >= MAX_WORDS {
        return Err(ApiError::bad_request(format!(
            "the dictionary is full ({MAX_WORDS} words)"
        )));
    }
    sqlx::query(
        "INSERT OR IGNORE INTO project_dictionary (project_id, word, added_by) VALUES (?, ?, ?)",
    )
    .bind(access.info.id)
    .bind(word)
    .bind(access.user.id)
    .execute(&app.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_word(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, word)): Path<(i64, String)>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Editor)?;
    sqlx::query("DELETE FROM project_dictionary WHERE project_id = ? AND word = ?")
        .bind(access.info.id)
        .bind(word)
        .execute(&app.db)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Serialize)]
pub struct Rules {
    disabled_rules: Vec<String>,
}

/// Replaces the disabled rules (editors: "Regel ignorieren" in the editor).
// ponytail: last write wins if two members change rules at the same moment; per-rule rows if
// that ever matters
pub async fn put_rules(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<Rules>,
) -> Result<Json<Rules>, ApiError> {
    access.info.my_role.require(Role::Editor)?;
    let mut rules = b.disabled_rules;
    rules.sort();
    rules.dedup();
    let valid = |r: &String| {
        !r.is_empty() && r.len() <= 100 && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    if rules.len() > MAX_RULES || !rules.iter().all(valid) {
        return Err(ApiError::bad_request(format!(
            "at most {MAX_RULES} rule ids such as DE_CASE"
        )));
    }
    sqlx::query("UPDATE projects SET spellcheck_disabled_rules = ? WHERE id = ?")
        .bind(serde_json::to_string(&rules).map_err(ApiError::internal)?)
        .bind(access.info.id)
        .execute(&app.db)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(Rules {
        disabled_rules: rules,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unclosed arguments must not make `annotate` quadratic (100 KB used to take seconds).
    #[test]
    fn unclosed_groups_are_bounded() {
        for unit in [
            r"\item[",
            r"\cite[",
            r"\section{",
            r"\newcommand{",
            r"\begin{x}[",
            "$$ $",
        ] {
            let src = unit.repeat(MAX_TEXT / unit.len());
            let t = std::time::Instant::now();
            check_cover(&src);
            // generous: quadratic took > 20 s in a debug build
            assert!(
                t.elapsed() < Duration::from_secs(10),
                "{unit}: {:?}",
                t.elapsed()
            );
        }
    }

    /// The parts cover the input exactly, in order.
    fn check_cover(src: &str) -> Annotated<'_> {
        let a = annotate(src);
        let mut at = 0;
        for (_, r, _) in &a.parts.0 {
            assert_eq!(r.start, at, "{src:?}");
            at = r.end;
        }
        assert_eq!(at, src.len(), "{src:?}");
        a
    }

    fn seen(src: &str) -> String {
        check_cover(src).seen()
    }

    #[test]
    fn commands_and_arguments() {
        assert_eq!(seen(r"Ein \emph{kurzer} Text."), "Ein kurzer Text.");
        assert_eq!(
            seen(r"\section*{Einleitung}\label{sec:intro}Hier."),
            "\n\nEinleitung\n\nHier."
        );
        assert_eq!(
            seen(r"Siehe Abb.~\ref{fig:a} und \cite[S.~3]{knuth84}."),
            "Siehe Abb. 1 und [1]."
        );
        assert_eq!(seen(r"\textbf{fett} \textcolor{red}{rot}"), "fett rot");
        assert_eq!(
            seen(r"\includegraphics[width=\linewidth]{img/plot.pdf}"),
            ""
        );
        assert_eq!(seen(r"\href{https://x.org}{Seite} \url{a_b}"), "Seite X");
        assert_eq!(
            seen("\\caption{Ein Bild}\\footnote{Eine Notiz.}"),
            "\n\nEin Bild\n\nEine Notiz."
        );
        assert_eq!(seen(r"\newcommand{\foo}[1]{Kein Text #1}Text"), "Text");
        assert_eq!(seen(r"Die \gls{api} ist"), "Die X ist");
        // preamble is markup
        let doc = "\\documentclass{article}\n\\usepackage[ngerman]{babel}\n\\begin{document}\nHallo\n\\end{document}\n";
        assert_eq!(seen(doc), "\nHallo\n\n");
    }

    #[test]
    fn math_verbatim_comments() {
        assert_eq!(
            seen(r"mit $x^2 + 1$ und $$\int f$$ gilt"),
            "mit X und X gilt"
        );
        assert_eq!(seen(r"also \(a\) oder \[b\] ."), "also X oder X .");
        assert_eq!(seen("Preis 5\\$ und $ allein"), "Preis 5$ und $ allein");
        assert_eq!(
            seen("Es gilt\n\\begin{equation}\n  E = mc^2\n\\end{equation}\nalso."),
            "Es gilt\nX\nalso."
        );
        assert_eq!(
            seen("A\n\\begin{lstlisting}[language=C]\nint x; // Fehlr\n\\end{lstlisting}\nB"),
            "A\n\nB"
        );
        assert_eq!(seen("\\begin{minted}{rust}\nfn x\n\\end{minted}"), "");
        assert_eq!(seen("Code \\verb|a_b%| hier"), "Code X hier");
        assert_eq!(seen("Code \\verb+offen"), "Code X");
        // comments: whole lines go with their line break, the paragraph break stays
        assert_eq!(seen("Satz eins % Notiz\nweiter"), "Satz eins \nweiter");
        assert_eq!(seen("eins\n% ganz\nzwei\n\ndrei"), "eins\nzwei\n\ndrei");
        assert_eq!(seen("eins % x\n\nzwei"), "eins \n\nzwei");
        assert_eq!(seen(r"50\% sind"), "50% sind");
        // unterminated environments run to the end
        assert_eq!(seen("x \\begin{verbatim}\nabc"), "x ");
    }

    #[test]
    fn symbols_and_accents() {
        assert_eq!(seen(r#"Gr\"o\ss e \"{U}bung"#), "Größe Übung");
        assert_eq!(seen(r"Stra\ss e"), "Straße");
        assert_eq!(
            seen(r"caf\'e Fran\c{c}ais \^a \`a \~n"),
            "café Français â à ñ"
        );
        assert_eq!(seen(r"Seiten 1--3 --- so"), "Seiten 1–3 — so");
        assert_eq!(seen(r"z.\,B. Silben\-trennung"), "z. B. Silbentrennung");
        assert_eq!(seen("Zeile\\\\[2mm]neu\\\\*x"), "Zeile\nneu\nx");
        assert_eq!(seen("``zitiert'' \\glqq so\\grqq"), "\"zitiert\" „so“");
        assert_eq!(
            seen("\\begin{itemize}\n\\item A\n\\item[b)] B\n\\end{itemize}"),
            "\n\n\n A\n\n\n B\n"
        );
        assert_eq!(seen(r"\begin{tabular}{l|r} a & b \end{tabular}"), " a & b ");
        assert_eq!(seen("umlaut ä 😀 \\"), "umlaut ä 😀 ");
    }

    async fn lt_check(lt: &LanguageTool, src: &str, dict: &HashSet<String>) -> Vec<Issue> {
        let form = lt_form(src, "de-DE".into(), vec![]);
        let res = lt
            .http
            .post(format!("{}/v2/check", lt.url))
            .form(&form)
            .send()
            .await
            .unwrap();
        let res: LtResponse = serde_json::from_slice(&res.bytes().await.unwrap()).unwrap();
        issues(src, 0, res.matches, dict)
    }

    /// Against a real server:
    /// `UNDERTREE_TEST_LANGUAGETOOL=http://127.0.0.1:8010 cargo test real_languagetool -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn real_languagetool() {
        let lt = LanguageTool::new(&std::env::var("UNDERTREE_TEST_LANGUAGETOOL").unwrap()).unwrap();
        let src = "\\documentclass{article}\n\\usepackage[ngerman]{babel}\n\\begin{document}\n\
                   \\section{Einleitung}\n😀 Das Ergebniss in \\cref{fig:plot} zeigt, dass $f(x) = x^2$ \
                   gilt~\\cite[S.~3]{knuth}. % Notitz\nDie Gr\\\"o\\ss e ist \\emph{wichtig}, \
                   siehe \\url{https://exmple.org/fehlr}.\n\n\\begin{verbatim}\nKein Fehlr\n\
                   \\end{verbatim}\n\\end{document}\n";
        let found = lt_check(&lt, src, &HashSet::new()).await;
        let words: Vec<&str> = (found.iter())
            .map(|i| comments::slice16(src, i.start, i.end).unwrap())
            .collect();
        assert_eq!(words, ["Ergebniss"], "{found:#?}");
        assert_eq!(found[0].category, "TYPOS");
        assert!(found[0].replacements.contains(&"Ergebnis".to_owned()));
        // the dictionary filters it
        let dict = HashSet::from(["ergebniss".to_owned()]);
        assert_eq!(lt_check(&lt, src, &dict).await, []);

        // headings, lists, tables, labels: no noise from the markup
        let src = "\\section{Methoden}\\label{sec:m}\nWir nutzen drei Schritte:\n\\begin{itemize}\n  \
                   \\item Erstens messen wir.\n  \\item[b)] Dann rechnen wir.\n\\end{itemize}\n\
                   \\begin{table}[h]\n\\begin{tabular}{l|r}\nWert & Einheit \\\\\n\\hline\n\
                   Länge & Meter\n\\end{tabular}\n\\caption{Messwerte}\\label{tab:m}\n\\end{table}\n";
        assert_eq!(lt_check(&lt, src, &HashSet::new()).await, []);
    }

    #[test]
    fn json_and_offsets() {
        let src = "😀 \\emph{Fehlr} $x$";
        let a = check_cover(src);
        let v: serde_json::Value = serde_json::from_str(&a.json()).unwrap();
        assert_eq!(
            v,
            json!({ "annotation": [
                { "text": "😀 " },
                { "markup": "\\emph{" },
                { "text": "Fehlr" },
                { "markup": "}" },
                { "text": " " },
                { "markup": "$x$", "interpretAs": "X" },
            ]})
        );
    }
}
