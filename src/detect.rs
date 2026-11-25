//! Root files and TeX engine of LaTeX sources (docs/API.md → LaTeX compile, Engine detection).
//! Pure: works on `(path, text)` pairs (`/`-separated paths), no I/O.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::compile::Engine;

/// Lines of a root searched for a magic comment.
const MAGIC_LINES: usize = 20;
/// Engine conditionals (`iftex`, `ifxetex`, `ifluatex`, `ifpdf`): what they guard runs only with
/// that engine, so it says nothing about the engine the document needs.
const ENGINE_IFS: &[&str] = &[
    "ifPDFTeX", "ifXeTeX", "ifLuaTeX", "ifpdf", "ifxetex", "ifluatex", "ifpdftex",
];
/// `\if…` macros that take arguments and have no `\fi` (ifthen, etoolbox).
// ponytail: fixed list; another `\if…` macro without `\fi` inside an engine conditional makes the
// rest of that file count as conditional (→ `pdflatex`), add it here when one shows up
const NO_FI: &[&str] = &[
    "ifthenelse",
    "ifbool",
    "iftoggle",
    "ifdef",
    "ifundef",
    "ifcsdef",
    "ifcsundef",
    "ifdefmacro",
    "ifstrequal",
    "ifstrempty",
    "ifblank",
    "ifnumcomp",
    "ifdimcomp",
    "ifnumequal",
    "ifnumgreater",
    "ifnumless",
    "ifdefempty",
    "ifcsempty",
    "ifdefstring",
    "ifcsstring",
    "ifboolexpr",
    "ifboolexpe",
    "ifcsvoid",
    "ifdefvoid",
];
/// Package (or environment/primitive) → engine it needs.
const MARKERS: &[(&str, Engine)] = &[
    ("luacode", Engine::Lualatex),
    ("luacode*", Engine::Lualatex),
    ("luaotfload", Engine::Lualatex),
    ("directlua", Engine::Lualatex),
    ("fontspec", Engine::Xelatex),
    ("unicode-math", Engine::Xelatex),
    ("polyglossia", Engine::Xelatex),
    ("xltxtra", Engine::Xelatex),
];

/// Without `%` comments. A backslash escapes the next byte (so `\%` is text, `\\%` a line break
/// and a comment); `\verb<d>…<d>` / `\verb*<d>…<d>` is skipped up to its closing delimiter.
pub fn uncommented_line(l: &str) -> &str {
    let b = l.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\'
                if b[i + 1..].starts_with(b"verb")
                    && !b.get(i + 5).is_some_and(u8::is_ascii_alphabetic) =>
            {
                let mut d = i + 5;
                if b.get(d) == Some(&b'*') {
                    d += 1;
                }
                // an unterminated \verb runs to the end of the line
                let Some(&delim) = b.get(d) else { return l };
                match b[d + 1..].iter().position(|&c| c == delim) {
                    Some(k) => i = d + 1 + k + 1,
                    None => return l,
                }
            }
            b'\\' => i += 2,
            // `%` is ASCII, so `i` is a char boundary
            b'%' => return &l[..i],
            _ => i += 1,
        }
    }
    l
}

/// Environments whose body TeX reads as text, not code.
pub(crate) const VERBATIM: &[&str] = &[
    "verbatim",
    "verbatim*",
    "Verbatim",
    "Verbatim*",
    "BVerbatim",
    "LVerbatim",
    "lstlisting",
    "minted",
    "comment",
    "filecontents",
    "filecontents*",
];

/// Without `%` comments (see [`uncommented_line`]), and the bodies of verbatim-like environments are dropped too (a listing
/// showing `\begin{document}` or `\usepackage{fontspec}` is neither a root nor a marker).
/// Line numbers are kept.
pub fn code(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut end: Option<String> = None;
    for line in src.lines() {
        let mut rest = line;
        loop {
            if let Some(e) = &end {
                match rest.find(e.as_str()) {
                    Some(i) => {
                        rest = &rest[i + e.len()..];
                        end = None;
                    }
                    None => break,
                }
            } else {
                let l = uncommented_line(rest);
                match verbatim_begin(l) {
                    Some((i, env, after)) => {
                        out.push_str(&l[..i]);
                        end = Some(format!("\\end{{{env}}}"));
                        rest = &rest[after..];
                    }
                    None => {
                        out.push_str(l);
                        break;
                    }
                }
            }
        }
        out.push('\n');
    }
    out
}

/// Like [`code`], but comments and verbatim bodies become spaces instead of disappearing, so
/// byte offsets (and lines, also with `\r\n`) of the result are those of `src`.
pub fn masked(src: &str) -> String {
    fn blank(out: &mut String, s: &str) {
        out.push_str(&" ".repeat(s.len()));
    }
    let mut out = String::with_capacity(src.len());
    let mut end: Option<String> = None;
    for (n, line) in src.split('\n').enumerate() {
        if n > 0 {
            out.push('\n');
        }
        let mut rest = line;
        loop {
            if let Some(e) = &end {
                match rest.find(e.as_str()) {
                    Some(i) => {
                        blank(&mut out, &rest[..i + e.len()]);
                        rest = &rest[i + e.len()..];
                        end = None;
                    }
                    None => {
                        blank(&mut out, rest);
                        break;
                    }
                }
            } else {
                let l = uncommented_line(rest);
                match verbatim_begin(l) {
                    Some((i, env, after)) => {
                        out.push_str(&l[..i]);
                        blank(&mut out, &rest[i..after]);
                        end = Some(format!("\\end{{{env}}}"));
                        rest = &rest[after..];
                    }
                    None => {
                        out.push_str(l);
                        blank(&mut out, &rest[l.len()..]);
                        break;
                    }
                }
            }
        }
    }
    out
}

/// First `\begin{<verbatim env>}` in `l`: `(start, env, end of the begin)`.
fn verbatim_begin(l: &str) -> Option<(usize, &str, usize)> {
    let mut from = 0;
    while let Some(k) = l[from..].find("\\begin{") {
        let i = from + k;
        let name = &l[i + 7..];
        if let Some(j) = name.find('}') {
            if VERBATIM.contains(&&name[..j]) {
                return Some((i, &name[..j], i + 7 + j + 1));
            }
        }
        from = i + 7;
    }
    None
}

/// `% !TEX program = xelatex` / `% !TeX TS-program = lualatex` (any case) in the first lines.
fn magic_comment(src: &str) -> Option<Engine> {
    src.lines().take(MAGIC_LINES).find_map(|line| {
        let l = line.trim_start().strip_prefix('%')?;
        let l = l.trim_start_matches('%').trim().to_ascii_lowercase();
        let l = l.strip_prefix("!tex")?.trim_start();
        let l = l.strip_prefix("ts-").unwrap_or(l);
        let value = l.strip_prefix("program")?.trim_start().strip_prefix('=')?;
        match value.trim() {
            "pdflatex" | "pdftex" => Some(Engine::Pdflatex),
            "xelatex" | "xetex" => Some(Engine::Xelatex),
            "lualatex" | "luatex" => Some(Engine::Lualatex),
            _ => None,
        }
    })
}

/// An `\input`-like reference: `file` below `dir`, which is relative to the including file's base
/// (`sub`) or to the root's directory (`\import`).
#[derive(Debug)]
struct Include {
    dir: String,
    sub: bool,
    file: String,
    /// inside an engine conditional
    cond: bool,
    /// after `\begin{document}` in its file
    body: bool,
}

#[derive(Debug, Default)]
struct Parsed {
    root: bool,
    includes: Vec<Include>,
    /// markers outside engine conditionals, in order
    markers: Vec<(Engine, String)>,
    /// `% !TeX spellcheck = …`
    spell: Option<String>,
    /// main language of the last `babel` / `\setmainlanguage` (LanguageTool code or `auto`)
    lang: Option<&'static str>,
    /// last language among the `\documentclass` options (babel reads them too)
    class_lang: Option<&'static str>,
}

/// LanguageTool code of a babel / polyglossia language name (`variant` is polyglossia's).
fn lt_language(name: &str, variant: Option<&str>) -> Option<&'static str> {
    Some(match (name.trim(), variant.map(str::trim)) {
        ("german", Some("austrian")) | ("naustrian" | "austrian", _) => "de-AT",
        ("german", Some("swiss")) | ("nswissgerman" | "swissgerman", _) => "de-CH",
        ("ngerman" | "german", _) => "de-DE",
        ("english", Some("british" | "uk")) | ("british" | "UKenglish" | "ukenglish", _) => "en-GB",
        ("english" | "american" | "USenglish" | "usenglish", _) => "en-US",
        ("french" | "francais", _) => "fr",
        ("spanish", _) => "es",
        ("italian", _) => "it",
        ("dutch", _) => "nl",
        ("portuguese", Some("brazilian")) | ("brazilian" | "brazil", _) => "pt-BR",
        ("portuguese" | "portuges", _) => "pt-PT",
        ("polish", _) => "pl-PL",
        _ => return None,
    })
}

/// Main language of a babel option list: `main=…`, else the last language.
// ponytail: options not in `lt_language` are skipped, so `[english,czech]` gives en-US; add the
// language there when one shows up
fn babel_main(options: &str) -> Option<&'static str> {
    let opts: Vec<&str> = options.split(',').map(str::trim).collect();
    (opts
        .iter()
        .find_map(|o| lt_language(o.strip_prefix("main=")?, None)))
    .or_else(|| opts.iter().rev().find_map(|o| lt_language(o, None)))
}

/// `% !TeX spellcheck = de_DE` (TeXstudio, any case) in the first lines → `de-DE`.
pub fn spell_magic(src: &str) -> Option<String> {
    let word = |l: &str, w: &str| {
        let head = l.get(..w.len())?;
        head.eq_ignore_ascii_case(w)
            .then(|| l[w.len()..].trim_start().to_owned())
    };
    src.lines().take(MAGIC_LINES).find_map(|line| {
        let l = line.trim_start().strip_prefix('%')?;
        let l = word(l.trim_start_matches('%').trim(), "!tex")?;
        let l = word(&l, "spellcheck")?;
        let v = l.strip_prefix('=')?.trim();
        let ok = !v.is_empty()
            && v.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c));
        ok.then(|| v.replace('_', "-"))
    })
}

/// `{…}` (balanced) after optional whitespace: `(content, rest)`.
fn group(s: &str) -> Option<(&str, &str)> {
    group_of(s, b'{', b'}')
}

fn group_of(s: &str, open: u8, close: u8) -> Option<(&str, &str)> {
    let s = s.trim_start();
    let b = s.as_bytes();
    if b.first() != Some(&open) {
        return None;
    }
    let mut depth = 0;
    for (i, &c) in b.iter().enumerate() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some((&s[1..i], &s[i + 1..]));
            }
        }
    }
    None
}

/// A root: `\begin{document}` outside comments.
pub fn is_root(src: &str) -> bool {
    has_document(&code(src))
}

fn has_document(uncommented: &str) -> bool {
    uncommented.contains(r"\begin{document}")
}

fn parse(src: &str) -> Parsed {
    let text = code(src);
    let mut p = Parsed {
        root: has_document(&text),
        spell: spell_magic(src),
        ..Parsed::default()
    };
    // open conditionals inside the outermost engine conditional; 0 = outside
    let mut depth = 0usize;
    let mut body = false;
    let mut prev = "";
    let mut rest = text.as_str();
    while let Some(i) = rest.find('\\') {
        let after = &rest[i + 1..];
        let len = after
            .find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(after.len());
        if len == 0 {
            // control symbol such as `\\` or `\%`
            rest = &after[after.chars().next().map_or(0, char::len_utf8)..];
            prev = "";
            continue;
        }
        let (name, tail) = after.split_at(len);
        rest = tail;
        let cond = depth > 0;
        let opens = name.starts_with("if") && prev != "newif" && !NO_FI.contains(&name);
        if name == "fi" {
            depth = depth.saturating_sub(1);
        } else if opens && (depth > 0 || ENGINE_IFS.contains(&name)) {
            depth += 1;
        }
        let mut marker = |m: &str| {
            if let Some((_, e)) = MARKERS.iter().find(|(n, _)| *n == m) {
                if !cond {
                    p.markers
                        .push((*e, format!("package:{}", m.trim_end_matches('*'))));
                }
            }
        };
        match name {
            "usepackage" | "RequirePackage" => {
                let (opts, t) = group_of(tail, b'[', b']').unwrap_or(("", tail));
                if let Some((list, _)) = group(t) {
                    list.split(',').for_each(|n| marker(n.trim()));
                    if list.split(',').any(|n| n.trim() == "babel") {
                        p.lang = babel_main(opts).or(p.lang);
                    }
                }
            }
            "documentclass" => {
                if let Some((opts, _)) = group_of(tail, b'[', b']') {
                    p.class_lang = babel_main(opts);
                }
            }
            "setmainlanguage" | "setdefaultlanguage" => {
                let (opts, t) = group_of(tail, b'[', b']').unwrap_or(("", tail));
                if let Some((name, _)) = group(t) {
                    let variant = (opts.split(',')).find_map(|o| {
                        let (k, v) = o.split_once('=')?;
                        (k.trim() == "variant").then_some(v)
                    });
                    p.lang = Some(lt_language(name, variant).unwrap_or("auto"));
                }
            }
            "begin" => {
                if let Some((env, _)) = group(tail) {
                    body |= env.trim() == "document";
                    marker(env.trim());
                }
            }
            // `\ifx\directlua\undefined` tests for LuaTeX, it doesn't need it
            "directlua" if !prev.starts_with("if") => marker(name),
            "input" | "include" | "subfile" => {
                if let Some((file, _)) = group(tail) {
                    p.includes.push(Include {
                        dir: String::new(),
                        sub: true,
                        file: file.trim().to_owned(),
                        cond,
                        body,
                    });
                }
            }
            "import" | "subimport" | "inputfrom" | "subinputfrom" | "includefrom"
            | "subincludefrom" => {
                let t = tail.strip_prefix('*').unwrap_or(tail);
                if let Some((dir, t)) = group(t) {
                    if let Some((file, _)) = group(t) {
                        p.includes.push(Include {
                            dir: dir.trim().to_owned(),
                            sub: name.starts_with("sub"),
                            file: file.trim().to_owned(),
                            cond,
                            body,
                        });
                    }
                }
            }
            _ => {}
        }
        prev = name;
    }
    p
}

/// `a/b/../c/./d` → `a/c/d`; `None` if it leaves the top or is absolute/empty.
pub fn normalize(path: &str) -> Option<String> {
    if path.starts_with('/') {
        return None;
    }
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    (!out.is_empty()).then(|| out.join("/"))
}

pub fn join(dir: &str, rel: &str) -> String {
    if dir.is_empty() {
        rel.to_owned()
    } else {
        format!("{dir}/{rel}")
    }
}

pub fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

/// Parsed `.tex` sources, see [`Sources::new`].
pub struct Sources {
    files: HashMap<String, (Parsed, Option<Engine>)>,
}

impl Sources {
    /// `(path, text)` of `.tex` files, paths `/`-separated and relative to a common base.
    pub fn new(files: impl IntoIterator<Item = (String, String)>) -> Self {
        let files = files
            .into_iter()
            .map(|(path, text)| {
                let parsed = parse(&text);
                (path, (parsed, magic_comment(&text)))
            })
            .collect();
        Self { files }
    }

    /// Paths of `.tex` files with `\begin{document}` outside comments, sorted.
    pub fn roots(&self) -> Vec<&str> {
        let mut roots: Vec<&str> = (self.files.iter())
            .filter(|(_, (p, _))| p.root)
            .map(|(path, _)| path.as_str())
            .collect();
        roots.sort();
        roots
    }

    /// The file an include refers to: `<path>.tex`, else `<path>` as written; missing → `None`.
    fn lookup(&self, path: &str) -> Option<String> {
        let path = normalize(path)?;
        if !path.ends_with(".tex") {
            let tex = format!("{path}.tex");
            if self.files.contains_key(&tex) {
                return Some(tex);
            }
        }
        self.files.contains_key(&path).then_some(path)
    }

    /// `root` and every file it includes transitively (breadth-first, each once), skipping
    /// includes inside engine conditionals unless `all`.
    fn reachable(&self, root: &str, all: bool) -> Vec<&str> {
        self.walk(root, all, &|_| true)
    }

    /// Like `reachable`, following only the includes of `root` itself for which `first` holds.
    fn walk(&self, root: &str, all: bool, first: &dyn Fn(&Include) -> bool) -> Vec<&str> {
        (self.walk_bases(root, all, first).into_iter())
            .map(|(p, _)| p)
            .collect()
    }

    /// `walk` with the directory each file's includes are relative to (the root's, or the one an
    /// `\import`-family include set).
    fn walk_bases(
        &self,
        root: &str,
        all: bool,
        first: &dyn Fn(&Include) -> bool,
    ) -> Vec<(&str, String)> {
        let Some((key, _)) = self.files.get_key_value(root) else {
            return Vec::new();
        };
        let root_dir = dir_of(root);
        let mut seen = HashSet::from([key.as_str()]);
        let mut out = Vec::new();
        let mut queue = VecDeque::from([(key.as_str(), root_dir.to_owned())]);
        while let Some((path, base)) = queue.pop_front() {
            out.push((path, base.clone()));
            let (parsed, _) = &self.files[path];
            let is_root = path == key.as_str();
            for inc in
                (parsed.includes.iter()).filter(|i| (all || !i.cond) && (!is_root || first(i)))
            {
                let dir = join(if inc.sub { &base } else { root_dir }, &inc.dir);
                let Some(found) = self.lookup(&join(&dir, &inc.file)) else {
                    continue;
                };
                let (key, _) = self.files.get_key_value(&found).expect("lookup found it");
                if seen.insert(key) {
                    queue.push_back((key, dir));
                }
            }
        }
        out
    }

    /// Every file `root` includes (incl. conditional ones) with the directory its own includes
    /// are relative to: the root's, or the one an `\import`-family include set.
    pub fn bases(&self, root: &str) -> HashMap<&str, String> {
        self.walk_bases(root, true, &|_| true).into_iter().collect()
    }

    /// Files `root` includes transitively from its preamble only (design), and from its body
    /// (`\begin{document}` onwards, content), each in include order, without `root`.
    pub fn preamble_and_body(&self, root: &str) -> (Vec<&str>, Vec<&str>) {
        let mut body = self.walk(root, true, &|i| i.body);
        let mut pre = self.walk(root, true, &|i| !i.body);
        body.retain(|p| *p != root);
        pre.retain(|p| *p != root && !body.contains(p));
        (pre, body)
    }

    /// Engine of `root` and why: `magic_comment`, `package:<name>` or `default`.
    pub fn engine(&self, root: &str) -> (Engine, String) {
        if let Some(e) = self.files.get(root).and_then(|(_, m)| *m) {
            return (e, "magic_comment".into());
        }
        let markers: Vec<&(Engine, String)> = (self.reachable(root, false).into_iter())
            .flat_map(|f| &self.files[f].0.markers)
            .collect();
        (markers.iter().find(|(e, _)| *e == Engine::Lualatex))
            .or_else(|| markers.first())
            .map(|(e, why)| (*e, why.clone()))
            .unwrap_or((Engine::Pdflatex, "default".into()))
    }

    /// Spell-check language of `root` (LanguageTool code): its `% !TeX spellcheck` comment, else
    /// the last babel / polyglossia main language in it and the files it includes, else a
    /// language option of `\documentclass`, else `auto`.
    pub fn language(&self, root: &str) -> String {
        let Some((p, _)) = self.files.get(root) else {
            return "auto".into();
        };
        if let Some(m) = &p.spell {
            return m.clone();
        }
        (self.reachable(root, false).iter())
            .filter_map(|f| self.files[*f].0.lang)
            .next_back()
            .or(p.class_lang)
            .unwrap_or("auto")
            .into()
    }

    /// The root among `roots` that includes `file` transitively (shallowest, then alphabetic).
    pub fn including<'a>(&self, file: &str, roots: &[&'a str]) -> Option<&'a str> {
        let depth = |p: &str| p.matches('/').count();
        (roots.iter())
            .filter(|r| self.reachable(r, true).contains(&file))
            .min_by_key(|r| (depth(r), **r))
            .copied()
    }

    /// The root among `roots` that `file` belongs to: one that includes it (shallowest, then
    /// alphabetic), else one in the nearest ancestor directory, else the only one.
    pub fn root_for<'a>(&self, file: &str, roots: &[&'a str]) -> Option<&'a str> {
        if let Some(r) = self.including(file, roots) {
            return Some(r);
        }
        let mut dir = Some(dir_of(file));
        while let Some(d) = dir {
            if let Some(r) = roots.iter().filter(|r| dir_of(r) == d).min() {
                return Some(r);
            }
            dir = (!d.is_empty()).then(|| dir_of(d));
        }
        match roots {
            [only] => Some(only),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources(files: &[(&str, &str)]) -> Sources {
        Sources::new(files.iter().map(|(p, t)| (p.to_string(), t.to_string())))
    }

    fn engine_of(main: &str) -> (Engine, String) {
        let doc = format!("{main}\n\\begin{{document}}\n\\end{{document}}\n");
        sources(&[("main.tex", &doc)]).engine("main.tex")
    }

    #[test]
    fn comment_scanner() {
        let cases = [
            (r"a % c", "a "),
            (r"50\% b % c", r"50\% b "),
            (r"x\\% \begin{document}", r"x\\"),
            (r"x\\\% y", r"x\\\% y"),
            (
                r"\verb|%| \begin{document} % c",
                r"\verb|%| \begin{document} ",
            ),
            (r"\verb*+%+ y%", r"\verb*+%+ y"),
            (r"\verb|% unterminated", r"\verb|% unterminated"),
            (r"\verbatim % c", r"\verbatim "),
            ("ü\\ü % c", "ü\\ü "),
            ("end\\", "end\\"),
        ];
        for (line, want) in cases {
            assert_eq!(uncommented_line(line), want, "{line}");
        }
    }

    #[test]
    fn verbatim_is_not_code() {
        let listing = "\\section{Demo}\n\\begin{verbatim}\n\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\n\\end{verbatim}\n";
        assert!(!is_root(listing));
        let lst = "\\begin{lstlisting}[language=TeX]\n\\begin{document}\n\\end{lstlisting}";
        assert!(!is_root(lst));
        // same line, and code after the end counts again
        assert!(!is_root(
            "\\begin{verbatim}\\begin{document}\\end{verbatim}"
        ));
        assert!(is_root(
            "\\begin{verbatim}x\\end{verbatim}\\begin{document}"
        ));
        // a commented-out \begin{verbatim} does not start one
        assert!(is_root("% \\begin{verbatim}\n\\begin{document}"));
        let main = "\\documentclass{article}\n\\begin{document}\n\\begin{minted}{latex}\n\\usepackage{fontspec}\n\\end{minted}\n\\end{document}\n";
        assert_eq!(engine_of(main), (Engine::Pdflatex, "default".into()));
        assert_eq!(
            code("a\n\\begin{verbatim}\nb\n\\end{verbatim}\nc")
                .lines()
                .count(),
            5
        );
    }

    #[test]
    fn masked_keeps_offsets() {
        let src = "a % c\r\n\\begin{verbatim}\n\\input{x}\n\\end{verbatim}\\input{y} ü\n";
        let m = masked(src);
        assert_eq!(m.len(), src.len());
        assert_eq!(m.matches('\n').count(), src.matches('\n').count());
        assert!(!m.contains("input{x}") && !m.contains('c'));
        let at = src.find("\\input{y}").unwrap();
        assert_eq!(&m[at..at + 9], "\\input{y}");
    }

    #[test]
    fn magic_comments() {
        use Engine::*;
        for (line, want) in [
            ("% !TEX program = xelatex", Xelatex),
            ("%!TeX TS-program = lualatex", Lualatex),
            ("  %% !tex ts-program=LuaLaTeX ", Lualatex),
            ("% !TEX program = pdftex", Pdflatex),
            ("% !TEX program = xetex", Xelatex),
            ("% !TEX program = luatex", Lualatex),
        ] {
            // the magic comment wins over packages
            let doc = format!("{line}\n\\usepackage{{fontspec}}\n\\usepackage{{luacode}}");
            assert_eq!(engine_of(&doc), (want, "magic_comment".into()), "{line}");
        }
        // unknown program, not a comment, too late → ignored
        assert_eq!(engine_of("% !TEX program = latex").1, "default");
        assert_eq!(engine_of(r"\verb|!TEX program = xelatex|").1, "default");
        let late = format!("{}% !TEX program = xelatex", "\n".repeat(MAGIC_LINES));
        assert_eq!(engine_of(&late).1, "default");
    }

    #[test]
    fn packages_and_conditionals() {
        use Engine::*;
        let e = |s: &str| engine_of(s);
        assert_eq!(e(""), (Pdflatex, "default".into()));
        assert_eq!(
            e(r"\usepackage{fontspec}"),
            (Xelatex, "package:fontspec".into())
        );
        assert_eq!(
            e(r"\usepackage[math-style=ISO]{unicode-math}").1,
            "package:unicode-math"
        );
        assert_eq!(e(r"\RequirePackage{xltxtra}").0, Xelatex);
        assert_eq!(
            e(r"\usepackage{amsmath, polyglossia}").1,
            "package:polyglossia"
        );
        // LuaLaTeX wins: fontspec works there too
        assert_eq!(
            e(r"\usepackage{fontspec,luacode}"),
            (Lualatex, "package:luacode".into())
        );
        assert_eq!(
            e(r"\directlua{tex.print(1)}"),
            (Lualatex, "package:directlua".into())
        );
        assert_eq!(e("\\begin{luacode*}\n\\end{luacode*}").1, "package:luacode");
        assert_eq!(e(r"\usepackage{luaotfload}").0, Lualatex);
        assert_eq!(e(r"% \usepackage{fontspec}").0, Pdflatex);
        // a non-ASCII control symbol doesn't stop the scan
        assert_eq!(e(r"\ü \usepackage{fontspec}").0, Xelatex);
        assert_eq!(e(r"\ifx\directlua\undefined \else \fi").0, Pdflatex);
        assert_eq!(e(r"\usepackage{fontspecx} \usepackage{iftex}").0, Pdflatex);

        // inside an engine conditional, \else included, nothing counts
        let iftex =
            "\\ifPDFTeX\n\\usepackage[T1]{fontenc}\n\\else\n\\ifXeTeX\n\\usepackage{fontspec}\n\
                     \\else\n\\RequirePackage{luacode}\n\\fi\n\\fi";
        assert_eq!(e(iftex), (Pdflatex, "default".into()));
        assert_eq!(e("\\ifXeTeX\\else\\usepackage{fontspec}\\fi").0, Pdflatex);
        for c in ENGINE_IFS {
            assert_eq!(
                e(&format!("\\{c} \\usepackage{{fontspec}} \\fi")).0,
                Pdflatex,
                "{c}"
            );
        }
        // after the matching \fi it counts again; nested \if…\fi inside are balanced
        let nested = "\\ifluatex \\ifnum1=1 \\ifx\\a\\b\\fi \\fi \\usepackage{luacode} \\fi \
                      \\usepackage{fontspec}";
        assert_eq!(e(nested), (Xelatex, "package:fontspec".into()));
        // \newif\ifdraft opens nothing; \ifthenelse has no \fi
        let defs = "\\ifxetex \\newif\\ifdraft \\ifthenelse{1=1}{}{} \\fi \\usepackage{fontspec}";
        assert_eq!(e(defs).0, Xelatex);
        // a non-engine conditional does not hide anything
        assert_eq!(e("\\ifdraft \\usepackage{fontspec} \\fi").0, Xelatex);
        // a conditional spanning an \input: the included file is not followed
        let s = sources(&[
            (
                "main.tex",
                "\\ifXeTeX\\input{xe}\\fi\n\\begin{document}\\end{document}",
            ),
            ("xe.tex", "\\usepackage{fontspec}"),
        ]);
        assert_eq!(s.engine("main.tex").0, Pdflatex);
    }

    #[test]
    fn include_graph() {
        let s = sources(&[
            (
                "paper/main.tex",
                "\\input{pre}\n\\begin{document}\n\\include{ch/a}\n\\end{document}",
            ),
            ("paper/pre.tex", "\\input{ch/b.tex}"),
            // cycle back to main and to a
            (
                "paper/ch/a.tex",
                "\\input{main} \\input{ch/a} \\subfile{ch/c}",
            ),
            ("paper/ch/b.tex", "\\usepackage{fontspec}"),
            ("paper/ch/c.tex", "\\import{../shared/}{lua}"),
            ("shared/lua.tex", "\\subimport{x}{deep}"),
            ("shared/x/deep.tex", "\\directlua{}"),
            ("paper/other.tex", "\\usepackage{luacode}"),
        ]);
        assert_eq!(
            s.reachable("paper/main.tex", true),
            [
                "paper/main.tex",
                "paper/pre.tex",
                "paper/ch/a.tex",
                "paper/ch/b.tex",
                "paper/ch/c.tex",
                "shared/lua.tex",
                "shared/x/deep.tex"
            ]
        );
        assert_eq!(
            s.engine("paper/main.tex"),
            (Engine::Lualatex, "package:directlua".into())
        );
        assert_eq!(s.roots(), ["paper/main.tex"]);
        // design: included from the preamble only; content: from the body
        let (pre, body) = s.preamble_and_body("paper/main.tex");
        assert_eq!(pre, ["paper/pre.tex", "paper/ch/b.tex"]);
        assert_eq!(
            body,
            [
                "paper/ch/a.tex",
                "paper/ch/c.tex",
                "shared/lua.tex",
                "shared/x/deep.tex"
            ]
        );
        // missing and escaping includes are ignored
        let s = sources(&[("m.tex", "\\input{nope}\\input{../../x}\\begin{document}")]);
        assert_eq!(s.reachable("m.tex", true), ["m.tex"]);
    }

    #[test]
    fn languages() {
        let lang = |pre: &str| {
            let doc = format!("{pre}\n\\begin{{document}}\n\\end{{document}}\n");
            sources(&[("main.tex", &doc)]).language("main.tex")
        };
        assert_eq!(lang(""), "auto");
        assert_eq!(lang(r"\usepackage[english,ngerman]{babel}"), "de-DE");
        assert_eq!(lang(r"\usepackage[ngerman, english]{babel}"), "en-US");
        assert_eq!(lang(r"\usepackage[main=british,ngerman]{babel}"), "en-GB");
        assert_eq!(lang(r"\usepackage[T1]{fontenc}\usepackage{babel}"), "auto");
        // babel takes the class options; its own come later and win
        assert_eq!(
            lang("\\documentclass[11pt,naustrian]{article}\n\\usepackage{babel}"),
            "de-AT"
        );
        assert_eq!(
            lang("\\documentclass[ngerman]{scrartcl}\n\\usepackage[french]{babel}"),
            "fr"
        );
        assert_eq!(lang(r"\setmainlanguage{german}"), "de-DE");
        assert_eq!(lang(r"\setmainlanguage[variant=swiss]{german}"), "de-CH");
        assert_eq!(lang(r"\setmainlanguage[variant=british]{english}"), "en-GB");
        assert_eq!(lang(r"\setdefaultlanguage{portuguese}"), "pt-PT");
        assert_eq!(lang(r"\usepackage[brazilian]{babel}"), "pt-BR");
        assert_eq!(lang(r"\setmainlanguage{klingon}"), "auto");
        assert_eq!(lang(r"% \usepackage[ngerman]{babel}"), "auto");
        // the magic comment wins (TeXstudio writes `de_DE`)
        let magic = "% !TeX spellcheck = de_DE\n\\usepackage[english]{babel}";
        assert_eq!(lang(magic), "de-DE");
        assert_eq!(lang("%!tex SpellCheck=en-GB"), "en-GB");
        assert_eq!(spell_magic("% !TeX spellcheck = de DE"), None);
        assert_eq!(spell_magic("\\verb|% !TeX spellcheck = de_DE|"), None);
        // from an included preamble file
        let s = sources(&[
            ("main.tex", "\\input{pre}\n\\begin{document}\\end{document}"),
            ("pre.tex", "\\usepackage[polish]{babel}"),
        ]);
        assert_eq!(s.language("main.tex"), "pl-PL");
        assert_eq!(s.language("missing.tex"), "auto");
    }

    #[test]
    fn root_for_files() {
        let s = sources(&[
            (
                "a/main.tex",
                "\\begin{document}\\input{chapters/one}\\end{document}",
            ),
            ("a/chapters/one.tex", "\\input{chapters/two}"),
            ("a/chapters/two.tex", ""),
            ("a/chapters/loose.tex", ""),
            (
                "a/z.tex",
                "\\begin{document}\\input{chapters/two}\\end{document}",
            ),
            (
                "a/deep/x/root.tex",
                "\\begin{document}\\input{../../chapters/two}",
            ),
            ("b/main.tex", "\\begin{document}"),
            ("b/sub/c.tex", "\\begin{document}"),
            ("c/x/only.tex", "\\begin{document}"),
            ("c/y/part.tex", ""),
        ]);
        let roots = s.roots();
        let a: Vec<&str> = roots
            .iter()
            .copied()
            .filter(|r| r.starts_with("a/"))
            .collect();
        let b: Vec<&str> = roots
            .iter()
            .copied()
            .filter(|r| r.starts_with("b/"))
            .collect();
        let c: Vec<&str> = roots
            .iter()
            .copied()
            .filter(|r| r.starts_with("c/"))
            .collect();
        // included transitively; several → shallowest, then alphabetic
        assert_eq!(s.root_for("a/chapters/one.tex", &a), Some("a/main.tex"));
        assert_eq!(s.root_for("a/chapters/two.tex", &a), Some("a/main.tex"));
        // not included → nearest ancestor directory
        assert_eq!(s.root_for("a/chapters/loose.tex", &a), Some("a/main.tex"));
        assert_eq!(s.root_for("b/sub/x/y.tex", &b), Some("b/sub/c.tex"));
        assert_eq!(s.root_for("b/other.tex", &b), Some("b/main.tex"));
        // the repo's only root
        assert_eq!(s.root_for("c/y/part.tex", &c), Some("c/x/only.tex"));
        assert_eq!(s.root_for("c/y/part.tex", &[]), None);
        assert_eq!(
            s.root_for("q/part.tex", &["a/main.tex", "b/main.tex"]),
            None
        );
    }
}
