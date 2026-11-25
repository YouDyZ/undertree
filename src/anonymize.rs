//! Anonymization of uploaded templates (docs/API.md → Templates, Anonymization): the content
//! becomes Lorem Ipsum, the design (preamble, classes, styles, fonts, logos) stays.
//! Pure: `(path, bytes)` in, `(path, bytes)` out; deterministic (a word always maps to the same
//! Lorem word, so repeated identifiers such as TikZ node names stay consistent).

use std::collections::{HashMap, HashSet};

use crate::detect::{self, Sources};

pub const PNG: &[u8] = include_bytes!("placeholder/placeholder.png");
pub const JPEG: &[u8] = include_bytes!("placeholder/placeholder.jpg");
pub const PDF: &[u8] = include_bytes!("placeholder/placeholder.pdf");
pub const EPS: &[u8] = include_bytes!("placeholder/placeholder.eps");
pub const SVG: &[u8] = include_bytes!("placeholder/placeholder.svg");

/// Design files: copied unchanged.
const KEEP_EXT: &[&str] = &[
    "cls", "sty", "bst", "bbx", "cbx", "dbx", "lbx", "def", "cfg", "clo", "fd", "ldf", "ttf",
    "otf", "pfb", "pfm", "afm", "tfm", "vf", "map", "enc", "woff", "woff2",
];
const TEX_EXT: &[&str] = &["tex", "ltx"];
/// Extensions tried for `\includegraphics{name}` (graphicx with pdfTeX/XeTeX/LuaTeX).
const GRAPHIC_EXT: &[&str] = &["", ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps", ".svg"];

/// Environments whose body is not TeX: becomes Lorem lines, same line count.
pub(crate) const VERBATIM: &[&str] = &[
    "verbatim",
    "verbatim*",
    "Verbatim",
    "Verbatim*",
    "BVerbatim",
    "LVerbatim",
    "spverbatim",
    "lstlisting",
    "minted",
    "comment",
];
pub(crate) const MATH: &[&str] = &[
    "equation",
    "equation*",
    "align",
    "align*",
    "alignat",
    "alignat*",
    "gather",
    "gather*",
    "multline",
    "multline*",
    "flalign",
    "flalign*",
    "eqnarray",
    "eqnarray*",
    "math",
    "displaymath",
];
/// Environments whose `{…}` arguments right after `\begin{env}` are specs, never text.
pub(crate) const ARG_ENVS: &[&str] = &[
    "tabular",
    "tabular*",
    "tabularx",
    "tabulary",
    "longtable",
    "xltabular",
    "array",
    "tblr",
    "longtblr",
    "minipage",
    "otherlanguage",
    "otherlanguage*",
    "multicols",
    "multicols*",
    "wrapfigure",
    "wraptable",
    "subfigure",
    "adjustbox",
    "tcolorbox",
];
/// Commands whose first `n` mandatory arguments are copied unchanged (labels, keys, paths,
/// lengths, colors, settings); their `[…]` options too.
pub(crate) const KEEP: &[(&str, usize)] = &[
    ("label", 1),
    ("ref", 1),
    ("eqref", 1),
    ("autoref", 1),
    ("Autoref", 1),
    ("cref", 1),
    ("Cref", 1),
    ("crefrange", 2),
    ("pageref", 1),
    ("nameref", 1),
    ("vref", 1),
    ("cite", 1),
    ("citep", 1),
    ("citet", 1),
    ("citeauthor", 1),
    ("citeyear", 1),
    ("citetitle", 1),
    ("Cite", 1),
    ("parencite", 1),
    ("Parencite", 1),
    ("textcite", 1),
    ("Textcite", 1),
    ("autocite", 1),
    ("Autocite", 1),
    ("footcite", 1),
    ("supercite", 1),
    ("nocite", 1),
    ("input", 1),
    ("include", 1),
    ("includeonly", 1),
    ("subfile", 1),
    ("import", 2),
    ("subimport", 2),
    ("includegraphics", 1),
    ("includepdf", 1),
    ("lstinputlisting", 1),
    ("inputminted", 2),
    ("usepackage", 1),
    ("RequirePackage", 1),
    ("documentclass", 1),
    ("url", 1),
    ("href", 1),
    ("bibliography", 1),
    ("bibliographystyle", 1),
    ("addbibresource", 1),
    ("printbibliography", 0),
    ("setlength", 2),
    ("addtolength", 2),
    ("vspace", 1),
    ("hspace", 1),
    ("color", 1),
    ("textcolor", 1),
    ("pagecolor", 1),
    ("colorbox", 1),
    ("fcolorbox", 2),
    ("rowcolor", 1),
    ("cellcolor", 1),
    ("columncolor", 1),
    ("definecolor", 3),
    ("setcounter", 2),
    ("addtocounter", 2),
    ("stepcounter", 1),
    ("pagestyle", 1),
    ("thispagestyle", 1),
    ("pagenumbering", 1),
    ("newgeometry", 1),
    ("geometry", 1),
    ("captionsetup", 1),
    ("setkomafont", 2),
    ("addtokomafont", 2),
    ("KOMAoptions", 1),
    ("hypersetup", 1),
    ("lstset", 1),
    ("tikzset", 1),
    ("tikzstyle", 1),
    ("pgfplotsset", 1),
    ("sisetup", 1),
    ("setlist", 1),
    ("usetikzlibrary", 1),
    ("selectlanguage", 1),
    ("foreignlanguage", 1),
    ("newenvironment", 1),
    ("renewenvironment", 1),
    ("newtheorem", 1),
    ("newcounter", 1),
    ("newlength", 1),
    ("graphicspath", 1),
    ("gls", 1),
    ("Gls", 1),
    ("GLS", 1),
    ("glspl", 1),
    ("Glspl", 1),
    ("acrshort", 1),
    ("acrlong", 1),
    ("acrfull", 1),
    ("ac", 1),
    ("Ac", 1),
    ("acs", 1),
    ("acl", 1),
    ("acf", 1),
    ("acp", 1),
    ("multicolumn", 2),
    ("multirow", 2),
    ("cline", 1),
    ("cmidrule", 1),
    ("setcopyright", 1),
    ("settopmatter", 1),
    ("citestyle", 1),
];
/// Metadata: first argument (and options) anonymized, digits included, also in the preamble.
const META: &[&str] = &[
    "author",
    "title",
    "subtitle",
    "date",
    "subject",
    "publishers",
    "dedication",
    "titlehead",
    "thanks",
    "email",
    "orcid",
    "affiliation",
    "institution",
    "address",
    "keywords",
];
/// `hypersetup` / hyperref option keys holding metadata.
/// Text-valued keys: hyperref metadata, and listing captions/titles (`lstlisting` options).
const META_KEYS: &[&str] = &[
    "pdfauthor",
    "pdftitle",
    "pdfsubject",
    "pdfkeywords",
    "caption",
    "title",
];

/// `\…name` macros that hold a fixed label of the document class or a package ("Abbildung",
/// "Inhaltsverzeichnis"): design, not data, so their text stays.
const LABEL_MACROS: &[&str] = &[
    "abstractname",
    "acronymname",
    "algorithmname",
    "alsoname",
    "appendixname",
    "appendixtocname",
    "appendixpagename",
    "bibname",
    "ccname",
    "chaptername",
    "contentsname",
    "enclname",
    "figurename",
    "glossaryname",
    "headtoname",
    "indexname",
    "listalgorithmname",
    "listfigurename",
    "listtablename",
    "lstlistingname",
    "lstlistlistingname",
    "nomname",
    "pagename",
    "partname",
    "prefacename",
    "proofname",
    "refname",
    "seename",
    "tablename",
];
/// Their `[…]` is text (a short title, an item label), not an option.
pub(crate) const SECTION_LIKE: &[&str] = &[
    "part",
    "chapter",
    "section",
    "subsection",
    "subsubsection",
    "paragraph",
    "subparagraph",
    "addchap",
    "addsec",
    "minisec",
    "caption",
    "item",
];
/// TeX units: a letter run right after a digit that is one of these is a dimension.
const UNITS: &[&str] = &[
    "pt", "mm", "cm", "in", "ex", "em", "bp", "pc", "sp", "dd", "cc", "mu", "nd", "nc", "px",
    "fil", "fill", "filll",
];
pub(crate) const DEFINE: &[&str] = &["newcommand", "renewcommand", "providecommand"];
const DEF: &[&str] = &["def", "gdef", "edef", "xdef"];

const LOREM: &[&str] = &[
    "a",
    "e",
    "o",
    "ad",
    "at",
    "et",
    "ex",
    "id",
    "in",
    "ut",
    "est",
    "non",
    "qui",
    "sed",
    "sit",
    "vel",
    "nam",
    "amet",
    "anim",
    "aute",
    "duis",
    "elit",
    "enim",
    "esse",
    "quis",
    "nisi",
    "sunt",
    "nunc",
    "dolor",
    "ipsum",
    "lorem",
    "magna",
    "minim",
    "culpa",
    "velit",
    "nulla",
    "irure",
    "dolore",
    "labore",
    "tempor",
    "veniam",
    "fugiat",
    "mollit",
    "cillum",
    "aliqua",
    "auctor",
    "aliquip",
    "commodo",
    "laborum",
    "nostrud",
    "officia",
    "ullamco",
    "egestas",
    "viverra",
    "deserunt",
    "proident",
    "pariatur",
    "occaecat",
    "sagittis",
    "molestie",
    "consequat",
    "excepteur",
    "cupidatat",
    "voluptate",
    "tincidunt",
    "fermentum",
    "incididunt",
    "adipiscing",
    "vestibulum",
];
const MAX_LOREM: usize = 10;
const MAX_DEPTH: usize = 32;

fn fnv(s: &str, salt: u64) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64 ^ salt.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    for b in s.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn lorem_of_len(n: usize, h: u64) -> &'static str {
    let words: Vec<&str> = LOREM.iter().copied().filter(|w| w.len() == n).collect();
    words[(h % words.len() as u64) as usize]
}

/// A Lorem word as long as `w` (in chars), with `w`'s capitalization.
pub fn lorem_word(w: &str) -> String {
    let n = w.chars().count();
    let key = w.to_lowercase();
    let mut out = String::new();
    let mut k = 0;
    while out.len() < n {
        let left = n - out.len();
        let h = fnv(&key, k);
        let len = if left <= MAX_LOREM {
            left
        } else {
            4 + (h % 7) as usize
        };
        out.push_str(lorem_of_len(len, h));
        k += 1;
    }
    let mut chars = w.chars();
    let first_upper = chars.next().is_some_and(char::is_uppercase);
    if first_upper && n > 1 && w.chars().all(|c| !c.is_lowercase()) {
        out.to_uppercase()
    } else if first_upper {
        let mut c = out.chars();
        let first = c.next().map(|f| f.to_ascii_uppercase()).unwrap_or_default();
        std::iter::once(first).chain(c).collect()
    } else {
        out
    }
}

fn lorem_digits(d: &str) -> String {
    let h = fnv(d, 7);
    (d.bytes().enumerate())
        .map(|(i, _)| char::from(b'0' + ((h >> (i % 16 * 4)) % 10) as u8))
        .collect()
}

/// Letters and digits of `s` replaced, everything else kept (`\verb` content).
fn scramble(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        let n = if c.is_alphabetic() {
            let n = rest
                .find(|c: char| !c.is_alphabetic())
                .unwrap_or(rest.len());
            out.push_str(&lorem_word(&rest[..n]));
            n
        } else if c.is_ascii_digit() {
            let n = rest
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(rest.len());
            out.push_str(&lorem_digits(&rest[..n]));
            n
        } else {
            out.push(c);
            c.len_utf8()
        };
        rest = &rest[n..];
    }
    out
}

/// A Lorem sentence of `n` chars (seeded by `seed`).
fn lorem_text(n: usize, seed: &str) -> String {
    let mut out = String::new();
    let mut k = 0;
    while out.len() < n {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(LOREM[(fnv(seed, k) % LOREM.len() as u64) as usize]);
        k += 1;
    }
    out.truncate(n);
    out.trim_end().to_owned()
}

/// Every non-blank line → its indentation plus Lorem of the same length.
pub fn lorem_lines(s: &str) -> String {
    s.split('\n')
        .map(|l| {
            let t = l.trim_start();
            if t.trim().is_empty() {
                l.to_owned()
            } else {
                let indent = &l[..l.len() - t.len()];
                format!("{indent}{}", lorem_text(t.trim_end().chars().count(), t))
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `% !TEX program = …` and friends (engine detection needs them).
fn is_magic(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('%')
        && t.trim_start_matches(['%', ' ', '\t'])
            .to_ascii_lowercase()
            .starts_with("!tex")
}

/// The verbatim environment `line` opens and doesn't close.
fn opens_verbatim(line: &str) -> Option<&'static str> {
    VERBATIM.iter().copied().find(|env| {
        line.rfind(&format!("\\begin{{{env}}}"))
            .is_some_and(|i| !line[i..].contains(&format!("\\end{{{env}}}")))
    })
}

/// Without `%` comments (`\%` is text, verbatim bodies untouched, magic comments kept). A
/// comment-only line is dropped; a comment after code leaves its `%` (it eats the line break).
pub fn strip_comments(src: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut verbatim: Option<&str> = None;
    for line in src.lines() {
        if let Some(env) = verbatim {
            let end = format!("\\end{{{env}}}");
            match line.find(&end) {
                Some(i) => {
                    verbatim = None;
                    let (head, tail) = line.split_at(i + end.len());
                    let code = detect::uncommented_line(tail);
                    let pct = if code.len() < tail.len() { "%" } else { "" };
                    out.push(format!("{head}{code}{pct}"));
                }
                None => out.push(line.to_owned()),
            }
            continue;
        }
        if is_magic(line) {
            out.push(line.to_owned());
            continue;
        }
        if let Some(code) = strip_line(line) {
            verbatim = opens_verbatim(&code);
            out.push(code);
        }
    }
    let mut s = out.join("\n");
    if src.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// `None`: a comment-only line.
fn strip_line(line: &str) -> Option<String> {
    let code = detect::uncommented_line(line);
    if code.len() == line.len() {
        Some(line.to_owned())
    } else if code.trim().is_empty() {
        None
    } else {
        Some(format!("{code}%"))
    }
}

/// Length of the group `t` starts with (`open` … matching `close`, `\x` escaped; `[`/`(` groups
/// only count at brace depth 0), `None` if `t` doesn't start one or it is unterminated.
// ponytail: scans to the end for an unterminated group, so many unclosed arguments make a file
// quadratic (like detect.rs); bound the scan if hostile uploads become a concern
// (uploaders are registered users)
pub(crate) fn group_len(t: &str, open: char, close: char) -> Option<usize> {
    if !t.starts_with(open) {
        return None;
    }
    let (mut depth, mut braces) = (0usize, 0usize);
    let mut it = t.char_indices();
    while let Some((i, c)) = it.next() {
        match c {
            '\\' => {
                it.next();
            }
            '{' if open != '{' => braces += 1,
            '}' if open != '{' => braces = braces.saturating_sub(1),
            c if c == open && braces == 0 => depth += 1,
            c if c == close && braces == 0 => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Length of a control word at the start of `t` (`\name`, letters and `@`), 0 if none.
pub(crate) fn control_word(t: &str) -> usize {
    match t.strip_prefix('\\') {
        Some(r) => {
            let n = (r.find(|c: char| !(c.is_ascii_alphabetic() || c == '@'))).unwrap_or(r.len());
            if n == 0 {
                0
            } else {
                n + 1
            }
        }
        None => 0,
    }
}

/// Whitespace at the start of `t` with at most one line break (a blank line ends arguments).
pub(crate) fn arg_space(t: &str) -> usize {
    let n = t.find(|c: char| !c.is_whitespace()).unwrap_or(t.len());
    let ws = &t[..n];
    if ws.matches('\n').count() > 1 {
        0
    } else {
        n
    }
}

/// Prose in `s`: a letter run of at least `min` letters outside control words that is not a
/// unit after a digit (`12pt`), or a run of at least 4 digits.
fn has_prose(s: &str, min: usize) -> bool {
    let mut prev_digit = false;
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        let n = if c == '\\' {
            control_word(rest).max(1 + rest[1..].chars().next().map_or(0, char::len_utf8))
        } else if c.is_alphabetic() {
            let n = rest
                .find(|c: char| !c.is_alphabetic())
                .unwrap_or(rest.len());
            if !(prev_digit && UNITS.contains(&&rest[..n])) && rest[..n].chars().count() >= min {
                return true;
            }
            n
        } else if c.is_ascii_digit() {
            let n = rest
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(rest.len());
            if n >= 4 {
                return true;
            }
            n
        } else {
            c.len_utf8()
        };
        prev_digit = c.is_ascii_digit();
        rest = &rest[n..];
    }
    false
}

/// A text-only macro body (author, matriculation number, …), see `Anon::define`.
fn text_only(name: &str, body: &str) -> bool {
    !name.contains('@')
        && !LABEL_MACROS.contains(&name.trim_start_matches('\\'))
        && !body.contains(['#', '$'])
        && !["\\(", "\\[", "\\ensuremath", "\\math"]
            .iter()
            .any(|m| body.contains(m))
        && has_prose(body, 2)
}

#[derive(Clone, Copy)]
struct Ctx {
    /// replace words (body)
    words: bool,
    /// replace every digit (metadata)
    digits: bool,
    /// images referenced here are design (preamble, title page, metadata)
    design: bool,
}

const PREAMBLE: Ctx = Ctx {
    words: false,
    digits: false,
    design: true,
};
const BODY: Ctx = Ctx {
    words: true,
    digits: false,
    design: false,
};
const META_CTX: Ctx = Ctx {
    words: true,
    digits: true,
    design: true,
};

#[derive(Default)]
struct Refs {
    /// `\includegraphics`/`\includepdf` paths and whether the reference is design
    graphics: Vec<(String, bool)>,
    /// `\lstinputlisting`/`\inputminted` paths
    listings: Vec<String>,
    graphicspath: Vec<String>,
}

#[derive(Default)]
struct Anon {
    refs: Refs,
    /// open `titlepage` environments in the current file
    titlepage: usize,
    /// nesting of `nested`
    depth: usize,
}

impl Anon {
    /// `text` of metadata (words and digits replaced); nested deeper than `MAX_DEPTH` only
    /// scrambled, so hostile input can't exhaust the stack.
    fn nested(&mut self, s: &str) -> String {
        if self.depth >= MAX_DEPTH {
            return scramble(s);
        }
        self.depth += 1;
        let out = self.text(s, META_CTX);
        self.depth -= 1;
        out
    }

    fn text(&mut self, s: &str, cx: Ctx) -> String {
        let mut out = String::with_capacity(s.len());
        let mut i = 0;
        while let Some(c) = s[i..].chars().next() {
            let rest = &s[i..];
            let n = match c {
                '\\' => self.command(rest, cx, &mut out),
                '$' => {
                    let n = math_len(rest);
                    out.push_str(&rest[..n]);
                    n
                }
                c if c.is_alphabetic() => {
                    let n = rest
                        .find(|c: char| !c.is_alphabetic())
                        .unwrap_or(rest.len());
                    let unit = UNITS.contains(&&rest[..n])
                        && s[..i].ends_with(|c: char| c.is_ascii_digit());
                    if cx.words && !unit {
                        out.push_str(&lorem_word(&rest[..n]));
                    } else {
                        out.push_str(&rest[..n]);
                    }
                    n
                }
                c if c.is_ascii_digit() => {
                    let n = rest
                        .find(|c: char| !c.is_ascii_digit())
                        .unwrap_or(rest.len());
                    if cx.digits || (cx.words && n >= 5) {
                        out.push_str(&lorem_digits(&rest[..n]));
                    } else {
                        out.push_str(&rest[..n]);
                    }
                    n
                }
                c => {
                    out.push(c);
                    c.len_utf8()
                }
            };
            i += n;
        }
        out
    }

    /// Handles the control sequence `s` starts with; returns the bytes consumed.
    fn command(&mut self, s: &str, cx: Ctx, out: &mut String) -> usize {
        let n = control_word(s);
        if n == 0 {
            let Some(c) = s[1..].chars().next() else {
                out.push('\\');
                return 1;
            };
            let close = match c {
                '(' => "\\)",
                '[' => "\\]",
                _ => {
                    out.push('\\');
                    out.push(c);
                    return 1 + c.len_utf8();
                }
            };
            let len = s[2..].find(close).map_or(2, |k| 2 + k + 2);
            out.push_str(&s[..len]);
            return len;
        }
        let name = &s[1..n];
        let mut used = n;
        if s[n..].starts_with('*') {
            used += 1;
        }
        out.push_str(&s[..used]);
        let tail = &s[used..];
        used + match name {
            "verb" => verb(tail, out),
            "lstinline" => {
                let k = options(tail, out);
                k + if tail[k..].starts_with('{') {
                    0
                } else {
                    verb(&tail[k..], out)
                }
            }
            "begin" => self.begin(tail, out),
            "end" => {
                let Some(len) = group_len(tail, '{', '}') else {
                    return used;
                };
                if tail[1..len - 1].trim() == "titlepage" {
                    self.titlepage = self.titlepage.saturating_sub(1);
                }
                out.push_str(&tail[..len]);
                len
            }
            m if DEFINE.contains(&m) || DEF.contains(&m) => self.define(name, tail, out),
            m if META.contains(&m) => {
                let mut k = 0;
                while let Some(len) = group_len(&tail[k..], '[', ']') {
                    out.push_str(&self.nested(&tail[k..k + len]));
                    k += len;
                }
                let ws = arg_space(&tail[k..]);
                match group_len(&tail[k + ws..], '{', '}') {
                    Some(len) => {
                        out.push_str(&tail[k..k + ws]);
                        let arg = &tail[k + ws..k + ws + len];
                        out.push_str(&self.nested(arg));
                        k + ws + len
                    }
                    None => k,
                }
            }
            m if SECTION_LIKE.contains(&m) => 0,
            m => match KEEP.iter().find(|(k, _)| *k == m) {
                Some((_, args)) => self.keep_args(name, tail, *args, cx, out),
                None => options(tail, out),
            },
        }
    }

    /// Copies the first `n` mandatory arguments (and options) of `\name`, recording references.
    fn keep_args(&mut self, name: &str, tail: &str, n: usize, cx: Ctx, out: &mut String) -> usize {
        let (mut used, mut k) = (0, 0);
        loop {
            let ws = arg_space(&tail[used..]);
            let t = &tail[used + ws..];
            let len = if let Some(len) = group_len(t, '[', ']') {
                let opt = &t[..len];
                out.push_str(&tail[used..used + ws]);
                if matches!(name, "usepackage" | "RequirePackage") {
                    out.push_str(&self.keyval_meta(opt));
                } else {
                    out.push_str(opt);
                }
                len
            } else if k < n && (t.starts_with('{') || control_word(t) > 0) {
                let len = group_len(t, '{', '}').unwrap_or_else(|| control_word(t));
                if len == 0 {
                    break;
                }
                let arg = if t.starts_with('{') {
                    &t[1..len - 1]
                } else {
                    &t[..len]
                };
                self.reference(name, k, arg, cx);
                out.push_str(&tail[used..used + ws]);
                if name == "hypersetup" {
                    out.push_str(&self.keyval_meta(&t[..len]));
                } else {
                    out.push_str(&t[..len]);
                }
                k += 1;
                len
            } else {
                break;
            };
            used += ws + len;
        }
        used
    }

    fn reference(&mut self, name: &str, k: usize, arg: &str, cx: Ctx) {
        let design = cx.design || self.titlepage > 0;
        match (name, k) {
            ("includegraphics" | "includepdf", 0) => {
                self.refs.graphics.push((arg.trim().to_owned(), design))
            }
            ("lstinputlisting", 0) | ("inputminted", 1) => {
                self.refs.listings.push(arg.trim().to_owned())
            }
            ("graphicspath", 0) => {
                let mut rest = arg.trim_start();
                while let Some(len) = group_len(rest, '{', '}') {
                    self.refs
                        .graphicspath
                        .push(rest[1..len - 1].trim().to_owned());
                    rest = rest[len..].trim_start();
                }
            }
            _ => {}
        }
    }

    /// `[…]`/`{…}` key-value list with the values of `META_KEYS` anonymized.
    fn keyval_meta(&mut self, group: &str) -> String {
        let (open, inner, close) = (
            &group[..1],
            &group[1..group.len() - 1],
            &group[group.len() - 1..],
        );
        let mut items = Vec::new();
        let (mut depth, mut start) = (0usize, 0);
        for (i, c) in inner.char_indices() {
            match c {
                '{' => depth += 1,
                '}' => depth = depth.saturating_sub(1),
                ',' if depth == 0 => {
                    items.push(&inner[start..i]);
                    start = i + 1;
                }
                _ => {}
            }
        }
        items.push(&inner[start..]);
        let items: Vec<String> = (items.into_iter())
            .map(|item| match item.split_once('=') {
                Some((key, value)) if META_KEYS.contains(&key.trim()) => {
                    format!("{key}={}", self.nested(value))
                }
                _ => item.to_owned(),
            })
            .collect();
        format!("{open}{}{close}", items.join(","))
    }

    fn begin(&mut self, tail: &str, out: &mut String) -> usize {
        let Some(len) = group_len(tail, '{', '}') else {
            return 0;
        };
        let env = tail[1..len - 1].trim();
        out.push_str(&tail[..len]);
        let mut used = len;
        let end = format!("\\end{{{env}}}");
        if VERBATIM.contains(&env) {
            // `[…]` options (captions anonymized) and minted's `{language}` stay; everything
            // else up to \end — also text on the \begin line — is body
            while let Some(len) = group_len(&tail[used..], '[', ']') {
                out.push_str(&self.keyval_meta(&tail[used..used + len]));
                used += len;
            }
            if env.starts_with("minted") {
                if let Some(len) = group_len(&tail[used..], '{', '}') {
                    out.push_str(&tail[used..used + len]);
                    used += len;
                }
            }
            let body_len = tail[used..].find(&end).unwrap_or(tail.len() - used);
            out.push_str(&lorem_lines(&tail[used..used + body_len]));
            return used + body_len;
        }
        if MATH.contains(&env) {
            let body_len = tail[used..].find(&end).unwrap_or(0);
            out.push_str(&tail[used..used + body_len]);
            return used + body_len;
        }
        if env == "titlepage" {
            self.titlepage += 1;
        }
        loop {
            let t = &tail[used..];
            let len = match group_len(t, '[', ']') {
                Some(len) => len,
                None => match group_len(t, '{', '}') {
                    Some(len) if ARG_ENVS.contains(&env) || !has_prose(&t[..len], 3) => len,
                    _ => break,
                },
            };
            out.push_str(&t[..len]);
            used += len;
        }
        used
    }

    /// `\newcommand{\x}[n][d]{body}` / `\def\x#1{body}`: a body that is text only (no
    /// parameters, no math, prose or a ≥ 4-digit number; not an internal `@` macro or a
    /// `\…name` caption label) is anonymized including digits, any other is kept.
    fn define(&mut self, cmd: &str, tail: &str, out: &mut String) -> usize {
        let mut used = arg_space(tail);
        let t = &tail[used..];
        let (name, len) = if let Some(len) = group_len(t, '{', '}') {
            (t[1..len - 1].trim(), len)
        } else {
            let len = control_word(t);
            (&t[..len], len)
        };
        if len == 0 {
            return 0;
        }
        out.push_str(&tail[..used + len]);
        used += len;
        let mut params = false;
        if DEF.contains(&cmd) {
            let k = tail[used..].find('{').unwrap_or(0);
            params = tail[used..used + k].contains('#');
            out.push_str(&tail[used..used + k]);
            used += k;
        } else {
            loop {
                let ws = arg_space(&tail[used..]);
                let Some(len) = group_len(&tail[used + ws..], '[', ']') else {
                    break;
                };
                params = true;
                out.push_str(&tail[used..used + ws + len]);
                used += ws + len;
            }
        }
        let ws = arg_space(&tail[used..]);
        let t = &tail[used + ws..];
        let Some(len) = group_len(t, '{', '}') else {
            return used;
        };
        out.push_str(&tail[used..used + ws]);
        let body = &t[1..len - 1];
        if !params && text_only(name, body) {
            out.push('{');
            out.push_str(&self.nested(body));
            out.push('}');
        } else {
            out.push_str(&t[..len]);
        }
        used + ws + len
    }
}

/// `[…]` options right after a command (spaces allowed, no line break), copied.
pub(crate) fn options(tail: &str, out: &mut String) -> usize {
    let mut used = 0;
    loop {
        let ws = tail[used..]
            .find(|c: char| c != ' ' && c != '\t')
            .unwrap_or(tail.len() - used);
        match group_len(&tail[used + ws..], '[', ']') {
            Some(len) => {
                out.push_str(&tail[used..used + ws + len]);
                used += ws + len;
            }
            None => return used,
        }
    }
}

/// `\verb<d>…<d>`: content scrambled, delimiters kept; unterminated → rest of the line.
fn verb(tail: &str, out: &mut String) -> usize {
    let Some(d) = tail.chars().next().filter(|c| !c.is_whitespace()) else {
        return 0;
    };
    let body = &tail[d.len_utf8()..];
    let eol = body.find('\n').unwrap_or(body.len());
    let (content, closed) = match body[..eol].find(d) {
        Some(k) => (&body[..k], true),
        None => (&body[..eol], false),
    };
    out.push(d);
    out.push_str(&scramble(content));
    if closed {
        out.push(d);
    }
    d.len_utf8() + content.len() + if closed { d.len_utf8() } else { 0 }
}

/// Length of the math starting with `$`/`$$` at `s`; an unclosed `$` (before a blank line) is
/// a plain character.
pub(crate) fn math_len(s: &str) -> usize {
    let delim = if s.starts_with("$$") { "$$" } else { "$" };
    let mut it = s.char_indices().skip(delim.len());
    while let Some((i, c)) = it.next() {
        match c {
            '\\' => {
                it.next();
            }
            '$' if s[i..].starts_with(delim) => return i + delim.len(),
            '\n' if s[i + 1..].trim_start_matches([' ', '\t']).starts_with('\n') => break,
            _ => {}
        }
    }
    delim.len()
}

fn ext(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn placeholder(ext: &str) -> Option<&'static [u8]> {
    Some(match ext {
        "png" => PNG,
        "jpg" | "jpeg" => JPEG,
        "pdf" => PDF,
        "eps" | "ps" => EPS,
        "svg" => SVG,
        _ => return None,
    })
}

/// A `.bib` with one dummy entry per original key, keeping the entry type. Year 2000, from the
/// 27th entry on 2001, 2002 …: author-year styles run out of labels after "2000z".
pub fn dummy_bib(src: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    let mut entries = 0;
    while let Some(k) = src[i..].find('@') {
        let at = i + k;
        let rest = &src[at + 1..];
        let tl = rest
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(rest.len());
        let ty = &rest[..tl];
        let after = rest[tl..].trim_start();
        let start = src.len() - after.len();
        let close = match after.chars().next() {
            Some('{') => '}',
            Some('(') => ')',
            _ => {
                i = at + 1;
                continue;
            }
        };
        let open = if close == '}' { '{' } else { '(' };
        let len = group_len(after, open, close).unwrap_or(after.len());
        i = start + len;
        if ty.is_empty() || ["string", "comment", "preamble"].contains(&&*ty.to_lowercase()) {
            continue;
        }
        let inner = &after[1..];
        let key = inner[..inner.find([',', close]).unwrap_or(0)].trim();
        if key.is_empty() {
            continue;
        }
        let title = lorem_text(12 + (fnv(key, 3) % 5) as usize * 6, key);
        let title = title[..1].to_uppercase() + &title[1..];
        let year = 2000 + entries / 26;
        entries += 1;
        out.push_str(&format!(
            "@{ty}{{{key},\n  author = {{Mustermann, Max}},\n  title = {{{title}}},\n  \
             year = {{{year}}},\n}}\n\n"
        ));
    }
    out
}

/// The file `r` refers to, below the main file's directory or a `\graphicspath` entry, with
/// one of `exts` appended; else a file whose path ends with it.
fn resolve<'a>(
    r: &str,
    main_dir: &str,
    dirs: &[String],
    exts: &[&str],
    files: &HashSet<&'a str>,
) -> Option<&'a str> {
    let with_ext = |base: &str| {
        exts.iter()
            .find_map(|e| files.get(format!("{base}{e}").as_str()).copied())
    };
    let bases = std::iter::once("").chain(dirs.iter().map(String::as_str));
    for d in bases {
        let found = detect::normalize(&detect::join(main_dir, &detect::join(d, r)))
            .and_then(|p| with_ext(&p));
        if found.is_some() {
            return found;
        }
    }
    let r = r.trim_start_matches("./");
    let mut hits: Vec<&str> = (files.iter().copied())
        .filter(|f| {
            exts.iter()
                .any(|e| f.ends_with(&format!("/{r}{e}")) || *f == format!("{r}{e}"))
        })
        .collect();
    hits.sort();
    hits.first().copied()
}

/// The anonymized template: see the module docs and docs/API.md for the rules.
pub fn anonymize(files: Vec<(String, Vec<u8>)>, main: &str) -> Vec<(String, Vec<u8>)> {
    let tex: Vec<(String, String)> = (files.iter())
        .filter(|(p, _)| TEX_EXT.contains(&ext(p).as_str()))
        .map(|(p, d)| (p.clone(), String::from_utf8_lossy(d).into_owned()))
        .collect();
    let sources = Sources::new(tex.clone());
    let design: HashSet<String> = (sources.preamble_and_body(main).0.into_iter())
        .map(str::to_owned)
        .collect();
    let mut anon = Anon::default();
    let mut new_tex: HashMap<String, String> = HashMap::new();
    for (path, text) in &tex {
        let text = strip_comments(text);
        anon.titlepage = 0;
        let out = match text.find("\\begin{document}") {
            Some(i) => {
                let pre = anon.text(&text[..i], PREAMBLE);
                pre + &anon.text(&text[i..], BODY)
            }
            None if design.contains(path) => anon.text(&text, PREAMBLE),
            None => anon.text(&text, BODY),
        };
        new_tex.insert(path.clone(), out);
    }

    let paths: HashSet<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    let main_dir = detect::dir_of(main);
    let refs = &anon.refs;
    let design_graphics: HashSet<&str> = (refs.graphics.iter())
        .filter(|(_, design)| *design)
        .filter_map(|(r, _)| resolve(r, main_dir, &refs.graphicspath, GRAPHIC_EXT, &paths))
        .collect();
    // a graphic used in the content too becomes a placeholder
    let content_graphics: HashSet<&str> = (refs.graphics.iter())
        .filter(|(_, design)| !*design)
        .filter_map(|(r, _)| resolve(r, main_dir, &refs.graphicspath, GRAPHIC_EXT, &paths))
        .collect();
    let listings: HashSet<&str> = (refs.listings.iter())
        .filter_map(|r| resolve(r, main_dir, &[], &[""], &paths))
        .collect();

    let mut out = Vec::new();
    for (path, data) in &files {
        let e = ext(path);
        let new = if listings.contains(path.as_str()) {
            lorem_lines(&String::from_utf8_lossy(data)).into_bytes()
        } else if let Some(t) = new_tex.remove(path) {
            t.into_bytes()
        } else if e == "bib" {
            dummy_bib(&String::from_utf8_lossy(data)).into_bytes()
        } else if KEEP_EXT.contains(&e.as_str()) || data.is_empty() {
            data.clone()
        } else if let Some(p) = placeholder(&e) {
            let keep = design_graphics.contains(path.as_str())
                && !content_graphics.contains(path.as_str());
            if keep {
                data.clone()
            } else {
                p.to_vec()
            }
        } else {
            continue; // other data and text files
        };
        out.push((path.clone(), new));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(s: &str) -> String {
        Anon::default().text(&strip_comments(s), BODY)
    }

    fn preamble(s: &str) -> String {
        Anon::default().text(&strip_comments(s), PREAMBLE)
    }

    fn run(files: &[(&str, &[u8])], main: &str) -> HashMap<String, Vec<u8>> {
        let files = files
            .iter()
            .map(|(p, d)| (p.to_string(), d.to_vec()))
            .collect();
        anonymize(files, main).into_iter().collect()
    }

    fn text_of(m: &HashMap<String, Vec<u8>>, p: &str) -> String {
        String::from_utf8(m[p].clone()).unwrap()
    }

    #[test]
    fn lorem_words() {
        for n in 1..=MAX_LOREM {
            assert!(LOREM.iter().any(|w| w.len() == n), "no lorem word of {n}");
        }
        assert_eq!(lorem_word("Hallo").len(), 5);
        assert!(lorem_word("Hallo").starts_with(char::is_uppercase));
        assert!(lorem_word("Hallo")[1..].chars().all(char::is_lowercase));
        assert_eq!(lorem_word("HTWK"), lorem_word("htwk").to_uppercase());
        assert_eq!(lorem_word("Selbstständigkeitserklärung").len(), 27);
        // deterministic, independent of position
        assert_eq!(lorem_word("Wagner"), lorem_word("Wagner"));
        assert_ne!(lorem_word("Wagner"), "Wagner");
    }

    #[test]
    fn body_words_replaced_structure_kept() {
        let src = "\\section{Einleitung}\\label{sec:einleitung}\n\
                   Die Hardware wird in \\cref{fig:aufbau} gezeigt \\cite[S.~5]{knuth1984}.\n\
                   \\begin{figure}[htbp]\n\\includegraphics[width=0.5\\textwidth]{Abbildungen/aufbau}\n\
                   \\caption[Kurz]{Der Versuchsaufbau}\n\\end{figure}\n\
                   \\textbf{Wichtig:} \\href{https://example.org/x}{Webseite}, \\input{kapitel/zwei}\n\
                   \\vspace{1cm}\\textcolor{red}{Rotes Wort} \\begin{tabular}{|l|c|} a & b \\end{tabular}\n";
        let out = body(src);
        for word in [
            "Einleitung",
            "Hardware",
            "gezeigt",
            "Versuchsaufbau",
            "Kurz",
            "Wichtig",
            "Webseite",
            "Rotes",
        ] {
            assert!(!out.contains(word), "{word} survived: {out}");
        }
        for kept in [
            "\\section{",
            "\\label{sec:einleitung}",
            "\\cref{fig:aufbau}",
            "\\cite[S.~5]{knuth1984}",
            "\\begin{figure}[htbp]",
            "\\includegraphics[width=0.5\\textwidth]{Abbildungen/aufbau}",
            "\\href{https://example.org/x}{",
            "\\input{kapitel/zwei}",
            "\\vspace{1cm}",
            "\\textcolor{red}{",
            "\\begin{tabular}{|l|c|}",
            "\\end{tabular}",
            "\\textbf{",
            "\\end{figure}",
        ] {
            assert!(out.contains(kept), "{kept} missing: {out}");
        }
        // punctuation, capitalization and line structure stay
        assert_eq!(out.lines().count(), src.lines().count());
        assert!(out.contains(":} \\href"));
        let line = out.lines().nth(1).unwrap();
        assert!(line.starts_with(|c: char| c.is_uppercase()), "{line}");
        // a unit after a digit stays, other letters after digits don't
        let out = body("\\rule{1cm}{2pt}\\hskip 12pt esp32s3usbotg");
        assert!(out.contains("12pt") && !out.contains("usbotg"), "{out}");
    }

    #[test]
    fn comments_gone() {
        let out =
            body("Wert 50\\% Rabatt % geheim\n% ganze Zeile geheim\n\\\\% auch geheim\nEnde\n");
        assert!(!out.contains("geheim"), "{out}");
        assert!(out.contains("50\\% "), "{out}");
        assert_eq!(out.lines().count(), 3);
        assert!(out.lines().next().unwrap().ends_with('%'));
        assert!(out.contains("\\\\%"));
        // inside verbatim `%` is text, not a comment; magic comments stay
        let s = strip_comments(
            "% !TEX program = lualatex\n\\begin{verbatim}\n50% x\n\\end{verbatim} % c\n",
        );
        assert_eq!(
            s,
            "% !TEX program = lualatex\n\\begin{verbatim}\n50% x\n\\end{verbatim} %\n"
        );
        assert_eq!(strip_comments("a \\verb|%| b % c\n"), "a \\verb|%| b %\n");
    }

    #[test]
    fn math_kept() {
        let src = "Formel $E = mc^2 \\text{Energie}$ und \\(a+b\\) sowie \\[x^2\\]\n\
                   \\begin{equation}\\label{eq:x} \\sum_i \\text{Summe} \\end{equation} $$y$$ 5\\$ Preis\n";
        let out = body(src);
        for kept in [
            "$E = mc^2 \\text{Energie}$",
            "\\(a+b\\)",
            "\\[x^2\\]",
            "\\begin{equation}\\label{eq:x} \\sum_i \\text{Summe} \\end{equation}",
            "$$y$$",
            "5\\$",
        ] {
            assert!(out.contains(kept), "{kept} missing: {out}");
        }
        assert!(!out.contains("Formel") && !out.contains("Preis"), "{out}");
        // an unclosed $ is a character, the rest is still anonymized
        assert!(!body("5 $ Kosten\n\nmehr Text").contains("Kosten"));
    }

    #[test]
    fn verbatim_becomes_lorem() {
        let src = "\\begin{lstlisting}[language=Python]\ndef geheim():\n    return 42\n\\end{lstlisting}\n\
                   \\begin{verbatim}\nGeheimer Text\n\n\\end{verbatim}\n\\verb|Geheim| \\lstinline|geheim|\n";
        let out = body(src);
        assert!(!out.to_lowercase().contains("geheim"), "{out}");
        assert!(!out.contains("return"), "{out}");
        assert!(out.contains("\\begin{lstlisting}[language=Python]\n"));
        assert!(out.contains("\\end{lstlisting}") && out.contains("\\end{verbatim}"));
        assert_eq!(out.lines().count(), src.lines().count());
        // indentation stays
        assert!(out.lines().nth(2).unwrap().starts_with("    "));
        assert!(out.contains("\\verb|") && out.contains("\\lstinline|"));
    }

    #[test]
    fn verbatim_body_on_the_begin_line() {
        let src = "\\begin{verbatim}Alice Smith\\end{verbatim}\n\
                   \\begin{lstlisting}[language=TeX,caption={Code von Alice Smith}]Alice Smith\n\\end{lstlisting}\n\
                   \\begin{minted}[linenos]{python}Alice = Smith\n\\end{minted}\n";
        let out = body(src);
        assert!(!out.contains("Alice") && !out.contains("Smith"), "{out}");
        assert!(out.contains("\\begin{verbatim}") && out.contains("\\end{verbatim}"));
        assert!(out.contains("[language=TeX,caption="), "{out}");
        assert!(out.contains("\\begin{minted}[linenos]{python}"), "{out}");
        assert_eq!(out.lines().count(), src.lines().count());
    }

    #[test]
    fn name_macros_are_data_unless_labels() {
        let out = preamble(
            "\\newcommand{\\studentname}{Alice Smith}\n\\def\\supervisorname{Bob Jones}\n\
             \\renewcommand{\\contentsname}{Inhalt der Arbeit}\n",
        );
        for gone in ["Alice", "Smith", "Bob", "Jones"] {
            assert!(!out.contains(gone), "{gone}: {out}");
        }
        assert!(
            out.contains("\\renewcommand{\\contentsname}{Inhalt der Arbeit}"),
            "{out}"
        );
    }

    #[test]
    fn preamble_keeps_design_replaces_metadata() {
        let src = "\\documentclass[12pt]{scrbook}\n\\usepackage[pdfauthor={Max Muster}]{hyperref}\n\
                   \\author{Max Muster}\\title[Kurz]{Geheimer Titel}\\date{17. November 2025}\n\
                   \\hypersetup{pdftitle={Geheimer Titel}, colorlinks=true, pdfkeywords={Roboter}}\n\
                   \\newcommand{\\autor}{Max Muster}\n\\newcommand{\\matrikelnr}{82756}\n\
                   \\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\code}[1]{\\texttt{#1}}\n\
                   \\renewcommand{\\figurename}{Abb.}\n\\renewcommand{\\baselinestretch}{1.5}\n\
                   \\def\\betreuer{Prof. Dr. Name}\n\\def\\x#1{Text #1}\n\
                   \\newcommand{\\dezi}{Dezibot\\textsubscript{4}\\xspace}\n\
                   \\definecolor{Blau}{rgb}{0.1,0.1,0.7}\n\\setlength{\\parindent}{0pt}\nDesign Text\n";
        let out = preamble(src);
        for gone in [
            "Max", "Muster", "Geheimer", "Kurz", "November", "2025", "Roboter", "82756", "Prof",
            "Name", "Dezibot",
        ] {
            assert!(!out.contains(gone), "{gone} survived: {out}");
        }
        for kept in [
            "\\documentclass[12pt]{scrbook}",
            "]{hyperref}",
            "colorlinks=true",
            "\\newcommand{\\R}{\\mathbb{R}}",
            "\\newcommand{\\code}[1]{\\texttt{#1}}",
            "\\renewcommand{\\figurename}{Abb.}",
            "\\renewcommand{\\baselinestretch}{1.5}",
            "\\def\\x#1{Text #1}",
            "\\textsubscript{",
            "\\definecolor{Blau}{rgb}{0.1,0.1,0.7}",
            "\\setlength{\\parindent}{0pt}",
            "Design Text",
            "\\newcommand{\\autor}{",
        ] {
            assert!(out.contains(kept), "{kept} missing: {out}");
        }
        // the matriculation number is still a number of the same length
        let nr = out.split("\\matrikelnr}{").nth(1).unwrap();
        assert!(nr[..5].chars().all(|c| c.is_ascii_digit()) && nr[5..].starts_with('}'));
    }

    #[test]
    fn bib_dummies() {
        let bib = "% Kommentar\n@string{x = \"Geheim\"}\n@Article{knuth1984,\n  author = {Donald Knuth},\n  \
                   title = {The {TeX}book}, note = {mail@x.org}\n}\n@online(web:1, url={https://x})\n@misc{k2}";
        let out = dummy_bib(bib);
        assert!(out.contains("@Article{knuth1984,") && out.contains("@online{web:1,"));
        assert!(out.contains("@misc{k2,"));
        assert_eq!(out.matches("Mustermann, Max").count(), 3);
        assert_eq!(out.matches("year = {2000}").count(), 3);
        for gone in ["Knuth", "TeX", "Geheim", "mail", "https"] {
            assert!(!out.contains(gone), "{gone}: {out}");
        }
    }

    #[test]
    fn files() {
        let main = b"\\documentclass{article}\n\\input{header}\n\\begin{document}\n\
                     \\begin{titlepage}\\includegraphics{logo}\\end{titlepage}\n\
                     \\includegraphics{bilder/foto.jpg}\\includegraphics{diagramm}\n\
                     \\lstinputlisting{code/main.py}\\input{kapitel/eins}\n\\end{document}\n";
        let m = run(
            &[
                ("main.tex", main),
                ("header.tex", b"\\usepackage{x}\\graphicspath{{bilder/}}\n\\includegraphics{wappen}\n\\author{Geheim}"),
                ("kapitel/eins.tex", b"Geheimer Inhalt\n"),
                ("unused.tex", b"Unbenutzter Inhalt\n"),
                ("logo.png", b"LOGO"),
                ("bilder/wappen.pdf", b"WAPPEN"),
                ("bilder/foto.jpg", b"FOTO"),
                ("bilder/diagramm.pdf", b"DIAGRAMM"),
                ("bilder/frei.png", b"FREI"),
                ("bilder/x.eps", b"EPS"),
                ("bilder/x.svg", b"SVG"),
                ("code/main.py", b"print('geheim')\nx = 1\n"),
                ("refs.bib", b"@book{k, title={Geheim}}"),
                ("my.cls", b"% design\n"),
                ("fonts/a.otf", b"OTF"),
                ("README.txt", b"geheim"),
                ("data.csv", b"1,2"),
                ("abbildungen/.gitkeep", b""),
            ],
            "main.tex",
        );
        let mut paths: Vec<&str> = m.keys().map(String::as_str).collect();
        paths.sort();
        assert_eq!(
            paths,
            [
                "abbildungen/.gitkeep",
                "bilder/diagramm.pdf",
                "bilder/foto.jpg",
                "bilder/frei.png",
                "bilder/wappen.pdf",
                "bilder/x.eps",
                "bilder/x.svg",
                "code/main.py",
                "fonts/a.otf",
                "header.tex",
                "kapitel/eins.tex",
                "logo.png",
                "main.tex",
                "my.cls",
                "refs.bib",
                "unused.tex",
            ]
        );
        // design: title page logo and preamble image; content: placeholders of the same type
        assert_eq!(m["logo.png"], b"LOGO");
        assert_eq!(m["bilder/wappen.pdf"], b"WAPPEN");
        assert_eq!(m["bilder/foto.jpg"], JPEG);
        assert_eq!(m["bilder/diagramm.pdf"], PDF);
        assert_eq!(m["bilder/frei.png"], PNG);
        assert_eq!(m["bilder/x.eps"], EPS);
        assert_eq!(m["bilder/x.svg"], SVG);
        assert_eq!(m["my.cls"], b"% design\n");
        assert_eq!(m["fonts/a.otf"], b"OTF");
        let code = text_of(&m, "code/main.py");
        assert!(
            !code.contains("geheim") && code.lines().count() == 2,
            "{code}"
        );
        assert!(text_of(&m, "refs.bib").starts_with("@book{k,"));
        for p in ["kapitel/eins.tex", "unused.tex", "header.tex", "refs.bib"] {
            assert!(!text_of(&m, p).contains("Geheim"), "{p}");
        }
        assert!(text_of(&m, "header.tex").contains("\\graphicspath{{bilder/}}"));
        let mut a = Anon::default();
        a.text("\\graphicspath{{a/}{ b/ }}", PREAMBLE);
        assert_eq!(a.refs.graphicspath, ["a/", "b/"]);
        // deeply nested metadata: no stack overflow, still anonymized
        let deep = "\\author{".repeat(100_000) + "Geheim" + &"}".repeat(100_000);
        assert!(!Anon::default().text(&deep, BODY).contains("Geheim"));
        // a logo also used in the content becomes a placeholder
        let main2 = b"\\begin{document}\\begin{titlepage}\\includegraphics{logo}\\end{titlepage}\
                      \\includegraphics{logo.png}\\end{document}";
        let m = run(&[("main.tex", main2), ("logo.png", b"LOGO")], "main.tex");
        assert_eq!(m["logo.png"], PNG);
    }

    #[test]
    fn define_in_body_and_acmart() {
        let out = body(
            "\\title{The Name}\\author{A-Vorname}\\affiliation{\\institution{Hochschule}\\postcode{04277}}\n\
             \\renewcommand{\\shortauthors}{Nachname und Co}\\begin{otherlanguage}{english}x\\end{otherlanguage}\n\
             \\begin{center}{\\Large Geheim}\\end{center}\\newenvironment{warnung}{a}{b}\\begin{warnung}\\end{warnung}",
        );
        for gone in [
            "Name",
            "Vorname",
            "Hochschule",
            "04277",
            "Nachname",
            "Geheim",
        ] {
            assert!(!out.contains(gone), "{gone}: {out}");
        }
        for kept in [
            "\\institution{",
            "\\begin{otherlanguage}{english}",
            "\\newenvironment{warnung}",
            "\\begin{warnung}",
        ] {
            assert!(out.contains(kept), "{kept}: {out}");
        }
    }

    /// Lowercase words of at least `min` letters outside control words, and digit runs of at
    /// least `min` digits.
    fn words(s: &str, min: usize) -> HashSet<String> {
        let mut out = HashSet::new();
        let mut rest = s;
        while let Some(c) = rest.chars().next() {
            let n = if c == '\\' {
                control_word(rest).max(1 + rest[1..].chars().next().map_or(0, char::len_utf8))
            } else if c.is_alphabetic() || c.is_ascii_digit() {
                let digit = c.is_ascii_digit();
                let n = (rest.find(|c: char| c.is_ascii_digit() != digit || !c.is_alphanumeric()))
                    .unwrap_or(rest.len());
                if rest[..n].chars().count() >= min {
                    out.insert(rest[..n].to_lowercase());
                }
                n
            } else {
                c.len_utf8()
            };
            rest = &rest[n..];
        }
        out
    }

    /// `s` without what anonymization keeps on purpose: control words, math, `[…]` options,
    /// arguments of `KEEP` commands and of `\begin`/`\end`.
    fn prose(s: &str) -> String {
        let skip = |t: &str, n: usize| -> usize {
            let (mut used, mut k) = (0, 0);
            loop {
                let ws = arg_space(&t[used..]);
                let g = &t[used + ws..];
                let len = match group_len(g, '[', ']') {
                    Some(len) => len,
                    None if k < n => match group_len(g, '{', '}') {
                        Some(len) => {
                            k += 1;
                            len
                        }
                        None => break,
                    },
                    None => break,
                };
                used += ws + len;
            }
            used
        };
        let mut out = String::new();
        let mut i = 0;
        while let Some(c) = s[i..].chars().next() {
            let rest = &s[i..];
            let n = if rest.starts_with("\\(") || rest.starts_with("\\[") {
                let close = if rest.starts_with("\\(") {
                    "\\)"
                } else {
                    "\\]"
                };
                rest[2..].find(close).map_or(2, |k| k + 4)
            } else if c == '\\' && control_word(rest) > 0 {
                let w = control_word(rest);
                let name = &rest[1..w];
                let w = w + usize::from(rest[w..].starts_with('*'));
                let tail = &rest[w..];
                w + match name {
                    "begin" | "end" => {
                        let len = group_len(tail, '{', '}').unwrap_or(0);
                        let env = if len > 0 { tail[1..len - 1].trim() } else { "" };
                        let mut used = len;
                        while let Some(l) = group_len(&tail[used..], '[', ']').or(group_len(
                            &tail[used..],
                            '{',
                            '}',
                        )) {
                            used += l;
                        }
                        if name == "begin" && MATH.contains(&env) {
                            used += tail[used..].find(&format!("\\end{{{env}}}")).unwrap_or(0);
                        }
                        used
                    }
                    m => skip(
                        tail,
                        KEEP.iter().find(|(k, _)| *k == m).map_or(0, |(_, n)| *n),
                    ),
                }
            } else if c == '\\' {
                1 + rest[1..].chars().next().map_or(0, char::len_utf8)
            } else if c == '$' {
                math_len(rest)
            } else {
                out.push(c);
                c.len_utf8()
            };
            i += n;
        }
        out
    }

    /// Metadata in original sources: arguments of `META` commands and text-only macros.
    fn metadata(s: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut i = 0;
        while let Some(k) = s[i..].find('\\') {
            let at = i + k;
            let w = control_word(&s[at..]).max(1);
            let name = &s[at + 1..at + w];
            let mut t = &s[at + w..];
            if META.contains(&name) {
                while let Some(len) = group_len(t, '[', ']') {
                    out.push(t[..len].to_owned());
                    t = &t[len..];
                }
                let t = t.trim_start();
                if let Some(len) = group_len(t, '{', '}') {
                    out.push(t[..len].to_owned());
                }
            } else if DEFINE.contains(&name) || DEF.contains(&name) {
                let t = t.trim_start();
                let (macro_name, len) = match group_len(t, '{', '}') {
                    Some(len) => (t[1..len - 1].trim(), len),
                    None => (&t[..control_word(t)], control_word(t)),
                };
                let rest = t[len..].trim_start();
                if let Some(len) = group_len(rest, '{', '}') {
                    if text_only(macro_name, &rest[1..len - 1]) {
                        out.push(rest[..len].to_owned());
                    }
                }
            }
            i = at + w;
        }
        out
    }

    /// The owner's real exports (`cargo test -- --ignored real_zips`): no prose of the
    /// originals' content and none of their metadata survive, and the anonymized template
    /// compiles. Prints only counts.
    #[tokio::test]
    #[ignore]
    async fn real_zips() {
        let downloads = std::path::Path::new("/home/blauer/Downloads");
        let prefixes = ["Bachelorarbeit_Lukas.zip", "Vorlage_für_Belegarbeit"];
        for (n, prefix) in prefixes.iter().enumerate() {
            let n = n + 1;
            let Some(zip) = (std::fs::read_dir(downloads).into_iter().flatten().flatten())
                .map(|e| e.path())
                .find(|p| {
                    let name = p.file_name().unwrap().to_string_lossy();
                    name.starts_with(prefix) && name.ends_with(".zip")
                })
            else {
                eprintln!("zip {n}: not present, skipped");
                continue;
            };
            let tree = crate::templates::extract(&std::fs::read(&zip).unwrap()).unwrap();
            let main = tree.main_file.clone();
            let orig: HashMap<String, String> = (tree.files.iter())
                .filter(|(p, _)| ext(p) == "tex")
                .map(|(p, d)| (p.clone(), strip_comments(&String::from_utf8_lossy(d))))
                .collect();
            let out = anonymize(tree.files.clone(), &main);
            let new: HashMap<String, String> = (out.iter())
                .filter(|(p, _)| TEX_EXT.contains(&ext(p).as_str()) || ext(p) == "bib")
                .map(|(p, d)| (p.clone(), String::from_utf8_lossy(d).into_owned()))
                .collect();

            // content: the main file's body plus every .tex file that is not design
            let sources = Sources::new(orig.clone());
            let design = sources.preamble_and_body(&main).0;
            let split = |t: &str| {
                t.find("\\begin{document}")
                    .map(|i| (t[..i].to_owned(), t[i..].to_owned()))
            };
            let (mut body_in, mut body_out, mut pre_in) =
                (String::new(), String::new(), String::new());
            for (p, t) in &orig {
                match split(t) {
                    Some((pre, body)) => {
                        pre_in += &pre;
                        body_in += &body;
                        body_out += &split(&new[p]).unwrap().1;
                    }
                    None if design.contains(&p.as_str()) => pre_in += t,
                    None => {
                        body_in += t;
                        body_out += &new[p];
                    }
                }
            }
            // the originals may contain Lorem Ipsum themselves
            let mut prose_in = words(&body_in, 6);
            prose_in.retain(|w| !LOREM.contains(&w.as_str()));
            let prose_out = words(&prose(&body_out), 6);
            let leaked = prose_in.intersection(&prose_out).count();

            let meta = metadata(&pre_in).into_iter().chain(metadata(&body_in));
            let meta_in: HashSet<String> = meta.flat_map(|m| words(&m, 4)).collect();
            // `\cite`/`\label` keys stay by design (and the .bib is synthetic but for its keys)
            let all_out: String = (new.iter())
                .filter(|(p, _)| ext(p) != "bib")
                .map(|(_, t)| prose(t))
                .collect();
            let meta_leaked = meta_in.intersection(&words(&all_out, 4)).count();
            let kept_images = (tree.files.iter())
                .filter(|(p, d)| {
                    placeholder(&ext(p)).is_some() && out.contains(&(p.clone(), d.clone()))
                })
                .count();

            // compile like the preview does
            let dir = tempfile::tempdir().unwrap();
            let build = dir.path().canonicalize().unwrap();
            let source = build.join("source");
            for (p, d) in &out {
                let path = source.join(p);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, d).unwrap();
            }
            let main_path = std::path::Path::new(&main);
            let cwd = source.join(main_path.parent().unwrap());
            crate::compile::mirror_dirs(&cwd, &cwd, &build).unwrap();
            // packages installed in TEXMFHOME are out of the sandbox's reach: next to the file
            let home = std::path::Path::new("/home/blauer/texmf/tex/latex");
            for pkg in std::fs::read_dir(home).into_iter().flatten().flatten() {
                for f in std::fs::read_dir(pkg.path()).unwrap().flatten() {
                    std::fs::copy(f.path(), cwd.join(f.file_name())).unwrap();
                }
            }
            let file = main_path.file_name().unwrap();
            let run = crate::compile::latexmk(&cwd, file, &build, tree.compiler).await;
            let stem = main_path.file_stem().unwrap().to_string_lossy();
            let log =
                std::fs::read_to_string(build.join(format!("{stem}.log"))).unwrap_or_default();
            let pages = (log.split("Output written on ").nth(1))
                .and_then(|l| l.split(" (").nth(1))
                .and_then(|l| l.split(' ').next())
                .unwrap_or("0")
                .to_owned();
            let pdf = build.join(format!("{stem}.pdf")).is_file();
            eprintln!(
                "zip {n}: {} files -> {}, {kept_images} original images kept; body words >= 6 \
                 letters: {} checked, {leaked} left; metadata words: {} checked, {meta_leaked} \
                 left; latexmk without errors: {}, PDF: {pdf}, {pages} pages",
                tree.files.len(),
                out.len(),
                prose_in.len(),
                meta_in.len(),
                run.as_ref().is_ok_and(|(ok, _)| *ok),
            );
            assert_eq!(leaked, 0, "zip {n}");
            assert_eq!(meta_leaked, 0, "zip {n}");
            assert!(pdf, "zip {n}: no PDF");
        }
    }
}
