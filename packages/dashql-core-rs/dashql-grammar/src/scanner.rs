//! The SQL scanner.
//!
//! A port of the flex scanner `grammar/scanner.l` that reproduces its output exactly, including its
//! quirks (docs/rust-port/quirks.md). Instead of a generated DFA, the scanner emulates the flex
//! matching discipline by hand: in every start condition, each rule computes its longest match at
//! the current position, the longest match wins, and ties go to the rule that comes first in
//! `scanner.l`. Line breaks are recorded for every match before its action runs, so text that an
//! action puts back with `yyless` is counted again when it is scanned a second time, exactly like
//! the C++ `YY_USER_ACTION`.
//!
//! [`scan`] then applies the lookahead filter of the C++ `Scanner::Scan`, which turns `NOT`, `NULLS`,
//! `WITH`, `.` and `VISUALIZE` into their `*_LA` variants depending on the following tokens.

use crate::keywords::{Keyword, KeywordCategory};
use crate::names::{NameId, NameRegistry};
use crate::span::TextSpan;
use crate::{symbol_kind::*, SymbolKind};
use std::collections::VecDeque;

/// The semantic value of a scanned symbol
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SymbolValue {
    None,
    /// An identifier
    Name(NameId),
    /// The text of a keyword (`VISUALIZE_LA` keeps the spelling `visualise` / `visualize`)
    Text(&'static str),
}

/// A scanned symbol
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Symbol {
    /// The terminal symbol kind
    pub kind: SymbolKind,
    /// The byte span in the text
    pub location: TextSpan,
    /// The semantic value
    pub value: SymbolValue,
}

impl Symbol {
    fn new(kind: SymbolKind, location: TextSpan) -> Self {
        Self { kind, location, value: SymbolValue::None }
    }
}

/// A literal that Hyper replaced with a typed marker comment, e.g. `/*Integer(4888)*/`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObfuscatedLiteral {
    /// The location of the marker
    pub location: TextSpan,
    /// An executable literal derived from the marker hash, e.g. `18568`
    pub replacement: String,
}

/// A scanner error
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScannerError {
    pub location: TextSpan,
    pub message: String,
}

/// The output of the scanner
#[derive(Clone, Debug, Default)]
pub struct ScannedScript {
    /// The origin id
    pub external_id: u32,
    /// The text version
    pub text_version: u64,
    /// The text
    pub text: String,
    /// The scanner errors
    pub errors: Vec<ScannerError>,
    /// The line breaks
    pub line_breaks: Vec<TextSpan>,
    /// The comments
    pub comments: Vec<TextSpan>,
    /// The obfuscated literals, ordered by offset
    pub obfuscated_literals: Vec<ObfuscatedLiteral>,
    /// The names
    pub names: NameRegistry,
    /// The symbols, ending with EOF
    pub symbols: Vec<Symbol>,
}

/// Scan a script.
pub fn scan(text: &str, text_version: u64, external_id: u32) -> ScannedScript {
    let mut out = ScannedScript {
        external_id,
        text_version,
        text: text.to_string(),
        ..Default::default()
    };
    let mut lexer = Lexer::new(text.as_bytes());
    let mut lookahead: VecDeque<Symbol> = VecDeque::new();
    loop {
        let symbol = next_symbol(&mut lexer, &mut out, &mut lookahead);
        out.symbols.push(symbol);
        if symbol.kind == S_YYEOF {
            break;
        }
    }
    out
}

/// The lookahead filter of the C++ `Scanner::Scan`.
fn next_symbol(lexer: &mut Lexer, out: &mut ScannedScript, lookahead: &mut VecDeque<Symbol>) -> Symbol {
    let current = match lookahead.pop_front() {
        Some(symbol) => symbol,
        None => lexer.lex(out),
    };
    match current.kind {
        S_NOT | S_NULLS_P | S_WITH | S_DOT | S_VISUALISE | S_VISUALIZE => {}
        _ => return current,
    }
    let next = lexer.lex(out);
    lookahead.push_back(next);
    match (current.kind, next.kind) {
        (S_NOT, S_BETWEEN | S_IN_P | S_LIKE | S_ILIKE | S_SIMILAR) => Symbol::new(S_NOT_LA, current.location),
        (S_NULLS_P, S_FIRST_P | S_LAST_P) => Symbol::new(S_NULLS_LA, current.location),
        (S_WITH, S_TIME | S_ORDINALITY) => Symbol::new(S_WITH_LA, current.location),
        (S_DOT, S_STAR) => Symbol::new(S_DOT_STAR_LA, current.location),
        (S_VISUALISE | S_VISUALIZE, S_USING) => {
            let renderer = lexer.lex(out);
            lookahead.push_back(renderer);
            match renderer.kind {
                S_VEGALITE | S_UMAP | S_MARKDOWN | S_TABLE => Symbol {
                    kind: S_VISUALIZE_LA,
                    location: current.location,
                    value: SymbolValue::Text(if current.kind == S_VISUALISE { "visualise" } else { "visualize" }),
                },
                _ => current,
            }
        }
        _ => current,
    }
}

/// The flex start conditions
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Initial,
    /// Bit string literal
    Xb,
    /// Backtick-quoted identifier
    Xbt,
    /// C-style comment
    Xc,
    /// Double-quoted identifier
    Xd,
    /// Hexadecimal string literal
    Xh,
    /// Quoted string
    Xq,
}

/// `{space}`
fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
}

/// `{horiz_space}`
fn is_horiz_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\x0c')
}

/// `{newline}`
fn is_newline(c: u8) -> bool {
    matches!(c, b'\n' | b'\r')
}

/// `{op_chars}`
fn is_op_char(c: u8) -> bool {
    matches!(
        c,
        b'~' | b'!' | b'@' | b'#' | b'^' | b'&' | b'|' | b'+' | b'-' | b'*' | b'/' | b'%' | b'<' | b'>' | b'='
    )
}

/// `{ident_start}`
fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c >= 0x80
}

/// `{ident_cont}`
fn is_ident_cont(c: u8) -> bool {
    is_ident_start(c) || c.is_ascii_digit() || c == b'$'
}

/// The single-character tokens of `matchSpecialCharacter`
fn special_character(c: u8) -> Option<SymbolKind> {
    Some(match c {
        b',' => S_COMMA,
        b'(' => S_LRB,
        b')' => S_RRB,
        b'[' => S_LSB,
        b']' => S_RSB,
        b'{' => S_LCB,
        b'}' => S_RCB,
        b'.' => S_DOT,
        b';' => S_SEMICOLON,
        b':' => S_COLON,
        b'+' => S_PLUS,
        b'-' => S_MINUS,
        b'*' => S_STAR,
        b'/' => S_DIVIDE,
        b'%' => S_MODULO,
        b'?' => S_QUESTION_MARK,
        b'^' => S_CIRCUMFLEX,
        b'&' => S_AMPERSAND,
        b'|' => S_PIPE,
        b'!' => S_EXCLAMATION_MARK,
        b'<' => S_LESS_THAN,
        b'>' => S_GREATER_THAN,
        b'=' => S_EQUALS,
        _ => return None,
    })
}

/// The two-character operator tokens that also match `{operator}`
fn two_char_operator(a: u8, b: u8) -> Option<SymbolKind> {
    Some(match (a, b) {
        (b'=', b'>') => S_EQUALS_GREATER,
        (b'<', b'=') => S_LESS_EQUALS,
        (b'>', b'=') => S_GREATER_EQUALS,
        (b'<', b'>') | (b'!', b'=') => S_NOT_EQUALS,
        _ => return None,
    })
}

/// The Hyper obfuscation markers: `/*<Type>(<4 uppercase hex digits>)*/`, matched case-sensitively.
const OBFUSCATION_MARKERS: [(&[u8], SymbolKind); 5] = [
    (b"String", S_SCONST),
    (b"Integer", S_ICONST),
    (b"Float", S_FCONST),
    (b"HexString", S_XCONST),
    (b"BitString", S_BCONST),
];

/// What a matched rule does
#[derive(Clone, Copy, Debug)]
enum Rule {
    /// Matched text without an action
    Skip,
    /// `{comment}`
    Comment,
    /// A Hyper obfuscation marker
    ObfuscatedLiteral(SymbolKind),
    /// `{xcstart}` (in INITIAL or nested in xc)
    CommentStart,
    /// `{xcstop}`
    CommentStop,
    /// `{xbstart}`, `{xhstart}`, `{xqstart}`, `{xdstart}`, `{xbtstart}`
    Begin(State),
    /// `{quotestop}` in xb, xh, xq
    QuoteStop,
    /// `{quotefail}` in xb, xh, xq
    QuoteFail,
    /// `{xdstop}`, `{xbtstop}`
    IdentifierStop,
    /// A token spanning the whole match
    Token(SymbolKind),
    /// `{raw_dot_trailing}`: the token excludes the space
    DotTrailing,
    /// `{operator}`
    Operator,
    /// `{integer}`
    Integer,
    /// A float rule that puts back `putback` characters
    Float { putback: usize },
    /// `{identifier}`
    Identifier,
}

struct Lexer<'a> {
    text: &'a [u8],
    pos: usize,
    state: State,
    ext_begin: TextSpan,
    ext_depth: usize,
}

impl<'a> Lexer<'a> {
    fn new(text: &'a [u8]) -> Self {
        Self {
            text,
            pos: 0,
            state: State::Initial,
            ext_begin: TextSpan::default(),
            ext_depth: 0,
        }
    }

    fn at(&self, i: usize) -> Option<u8> {
        self.text.get(i).copied()
    }

    fn is(&self, i: usize, c: u8) -> bool {
        self.at(i) == Some(c)
    }

    fn run(&self, from: usize, pred: impl Fn(u8) -> bool) -> usize {
        self.text[from.min(self.text.len())..].iter().take_while(|&&c| pred(c)).count()
    }

    fn span(begin: usize, length: usize) -> TextSpan {
        TextSpan::new(begin as u32, length as u32)
    }

    /// The location of the end-of-buffer match, which the EOF rules see
    fn eof_location(&self) -> TextSpan {
        Self::span(self.text.len(), 1)
    }

    /// Scan the next raw token (before the lookahead filter)
    fn lex(&mut self, out: &mut ScannedScript) -> Symbol {
        loop {
            if self.pos >= self.text.len() {
                let eof = self.eof_location();
                let message = match self.state {
                    State::Initial => return Symbol::new(S_YYEOF, eof),
                    State::Xc => "unterminated comment",
                    State::Xb => "unterminated bit string literal",
                    State::Xh => "unterminated hexadecimal bit string literal",
                    State::Xq => "unterminated quoted string",
                    State::Xd => "unterminated delimited identifier",
                    State::Xbt => "unterminated backtick-quoted identifier",
                };
                out.errors.push(ScannerError {
                    location: self.ext_begin.cover(eof),
                    message: message.to_string(),
                });
                self.state = State::Initial;
                continue;
            }
            let start = self.pos;
            let (rule, length) = match self.state {
                State::Initial => self.match_initial(start),
                State::Xc => self.match_comment(start),
                State::Xb | State::Xh => self.match_bit_or_hex_string(start),
                State::Xq => self.match_quoted_string(start),
                State::Xd => self.match_quoted_identifier(start, b'"'),
                State::Xbt => self.match_quoted_identifier(start, b'`'),
            };
            debug_assert!(length > 0);
            // YY_USER_ACTION
            for (i, &c) in self.text[start..start + length].iter().enumerate() {
                if c == b'\n' {
                    out.line_breaks.push(Self::span(start + i, 1));
                }
            }
            self.pos = start + length;
            let loc = Self::span(start, length);
            if let Some(symbol) = self.action(out, rule, loc) {
                return symbol;
            }
        }
    }

    /// Put back all but the first `n` characters of the current match (`yyless(n)`).
    fn yyless(&mut self, loc: &mut TextSpan, n: usize) {
        self.pos = loc.offset as usize + n;
        loc.length = n as u32;
    }

    /// Run the action of a rule. Returns a symbol if the action returns one.
    fn action(&mut self, out: &mut ScannedScript, rule: Rule, mut loc: TextSpan) -> Option<Symbol> {
        match rule {
            Rule::Skip => None,
            Rule::Comment => {
                out.comments.push(loc);
                None
            }
            Rule::ObfuscatedLiteral(kind) => {
                out.obfuscated_literals.push(obfuscated_literal(self.text, loc));
                Some(Symbol::new(kind, loc))
            }
            Rule::CommentStart => {
                self.yyless(&mut loc, 2);
                if self.state == State::Initial {
                    self.ext_begin = loc;
                    self.state = State::Xc;
                }
                self.ext_depth += 1;
                None
            }
            Rule::CommentStop => {
                self.ext_depth -= 1;
                if self.ext_depth == 0 {
                    out.comments.push(self.ext_begin.cover(loc));
                    self.state = State::Initial;
                }
                None
            }
            Rule::Begin(state) => {
                self.ext_begin = loc;
                self.state = state;
                None
            }
            Rule::QuoteStop => {
                let kind = self.literal_kind();
                self.state = State::Initial;
                Some(self.read_literal(kind, self.ext_begin.cover(loc)))
            }
            Rule::QuoteFail => {
                let kind = self.literal_kind();
                let literal_end = TextSpan::new(loc.offset, 1);
                self.yyless(&mut loc, 1);
                self.state = State::Initial;
                Some(self.read_literal(kind, self.ext_begin.cover(literal_end)))
            }
            Rule::IdentifierStop => {
                let (quote, message) = match self.state {
                    State::Xd => (b'"', "zero-length delimited identifier"),
                    _ => (b'`', "zero-length backtick-quoted identifier"),
                };
                let loc = self.ext_begin.cover(loc);
                if loc.length == 2 {
                    out.errors.push(ScannerError {
                        location: loc,
                        message: message.to_string(),
                    });
                }
                self.state = State::Initial;
                Some(self.read_quoted_identifier(out, loc, quote))
            }
            Rule::Token(kind) => Some(Symbol::new(kind, loc)),
            Rule::DotTrailing => Some(Symbol::new(S_DOT_TRAILING, TextSpan::new(loc.offset, 1))),
            Rule::Operator => Some(self.operator(out, loc)),
            // ReadInteger returns FCONST only if from_chars reports invalid_argument, which a digit
            // sequence never does (overflowing integers stay ICONST).
            Rule::Integer => Some(Symbol::new(S_ICONST, loc)),
            Rule::Float { putback } => {
                let keep = loc.length as usize - putback;
                self.yyless(&mut loc, keep);
                Some(Symbol::new(S_FCONST, loc))
            }
            Rule::Identifier => Some(self.read_identifier(out, loc)),
        }
    }

    /// The token kind of the literal that the current start condition scans
    fn literal_kind(&self) -> SymbolKind {
        match self.state {
            State::Xb => S_BCONST,
            State::Xh => S_XCONST,
            _ => S_SCONST,
        }
    }

    /// The location of a literal is trimmed of trailing spaces and newlines that `{quotestop}`
    /// swallowed (but not of tabs or comments).
    fn read_literal(&self, kind: SymbolKind, loc: TextSpan) -> Symbol {
        let text = &self.text[loc.offset as usize..loc.end() as usize];
        let trimmed = text.len() - text.iter().rev().take_while(|&&c| c == b' ' || c == b'\n').count();
        Symbol::new(kind, TextSpan::new(loc.offset, trimmed as u32))
    }

    fn read_quoted_identifier(&self, out: &mut ScannedScript, loc: TextSpan, quote: u8) -> Symbol {
        let text = &self.text[loc.offset as usize..loc.end() as usize];
        let inner = &text[1..text.len() - 1];
        let mut name = Vec::with_capacity(inner.len());
        let mut i = 0;
        while i < inner.len() {
            name.push(inner[i]);
            if inner[i] == quote && i + 1 < inner.len() && inner[i + 1] == quote {
                i += 1;
            }
            i += 1;
        }
        let id = out.names.register(&utf8(&name), loc);
        Symbol {
            kind: S_IDENT,
            location: loc,
            value: SymbolValue::Name(id),
        }
    }

    fn read_identifier(&self, out: &mut ScannedScript, loc: TextSpan) -> Symbol {
        let text = &self.text[loc.offset as usize..loc.end() as usize];
        let lower = text.to_ascii_lowercase();
        if let Some(keyword) = Keyword::find(&lower) {
            if keyword.category == KeywordCategory::VisUnreserved {
                out.names.register(keyword.name, loc);
            }
            return Symbol {
                kind: keyword.symbol,
                location: loc,
                value: SymbolValue::Text(keyword.name),
            };
        }
        let id = out.names.register(&utf8(&lower), loc);
        Symbol {
            kind: S_IDENT,
            location: loc,
            value: SymbolValue::Name(id),
        }
    }

    /// The `{operator}` action
    fn operator(&mut self, out: &mut ScannedScript, mut loc: TextSpan) -> Symbol {
        let start = loc.offset as usize;
        let yyleng = loc.length as usize;
        let text = &self.text[start..start + yyleng];

        // Embedded slash-star or dash-dash start a comment, the operator stops there.
        let find = |pattern: &[u8]| text.windows(2).position(|w| w == pattern);
        let mut nchars = yyleng;
        if let Some(i) = [find(b"/*"), find(b"--")].into_iter().flatten().min() {
            nchars = i;
        }
        // '+' and '-' cannot end a multi-char operator unless it contains chars that are not in
        // SQL operators.
        while nchars > 1 && matches!(text[nchars - 1], b'+' | b'-') {
            if text[..nchars - 1].iter().any(|c| b"~!@#^&|?%".contains(c)) {
                break;
            }
            nchars -= 1;
        }
        if nchars < yyleng {
            // The C++ scanner keeps yyleng - nchars characters (Postgres keeps nchars).
            let kept = yyleng - nchars;
            self.yyless(&mut loc, kept);
            if nchars == 1 {
                if let Some(kind) = special_character(text[0]) {
                    return Symbol::new(kind, loc);
                }
            }
            if nchars == 2 {
                let second = if kept >= 2 { text[1] } else { 0 };
                if let Some(kind) = two_char_operator(text[0], second) {
                    return Symbol::new(kind, loc);
                }
            }
        }
        if nchars >= 64 {
            out.errors.push(ScannerError {
                location: loc,
                message: "operator too long: operators longer than 64 bytes are not supported".to_string(),
            });
        }
        Symbol::new(S_Op, loc)
    }

    // -----------------------------------------------------------------------------------------
    // Rule matching
    // -----------------------------------------------------------------------------------------

    /// Match the rules of INITIAL. Returns the winning rule and its match length.
    fn match_initial(&self, p: usize) -> (Rule, usize) {
        let c = self.text[p];
        let next = self.at(p + 1);
        match c {
            _ if is_space(c) => (Rule::Skip, self.run(p, is_space)),
            b'-' if next == Some(b'-') => (Rule::Comment, 2 + self.run(p + 2, |c| !is_newline(c))),
            b'/' => {
                if let Some(m) = self.match_obfuscation_marker(p) {
                    return m;
                }
                if next == Some(b'*') {
                    // {xcstart} matches as much as {operator} and comes first
                    return (Rule::CommentStart, 2 + self.run(p + 2, is_op_char));
                }
                self.match_operator(p)
            }
            _ if is_op_char(c) => self.match_operator(p),
            b':' => match next {
                Some(b':') => (Rule::Token(S_TYPECAST), 2),
                Some(b'=') => (Rule::Token(S_COLON_EQUALS), 2),
                _ => (Rule::Token(S_COLON), 1),
            },
            b'.' => match next {
                Some(b'.') => (Rule::Token(S_DOT_DOT), 2),
                Some(d) if d.is_ascii_digit() => self.match_number(p),
                Some(s) if is_space(s) => (Rule::DotTrailing, 2),
                _ => (Rule::Token(S_DOT), 1),
            },
            _ if c.is_ascii_digit() => self.match_number(p),
            b'?' => match next {
                Some(n) if is_ident_cont(n) || n == b'"' => (Rule::Token(S_QUESTION_MARK), 1),
                _ => (Rule::Token(S_PARAM), 1),
            },
            b'$' => (Rule::Token(S_DOLLAR), 1),
            b'\'' => (Rule::Begin(State::Xq), 1),
            b'"' => (Rule::Begin(State::Xd), 1),
            b'`' => (Rule::Begin(State::Xbt), 1),
            b'b' | b'B' if next == Some(b'\'') => (Rule::Begin(State::Xb), 2),
            b'x' | b'X' if next == Some(b'\'') => (Rule::Begin(State::Xh), 2),
            _ if is_ident_start(c) => (Rule::Identifier, 1 + self.run(p + 1, is_ident_cont)),
            _ => match special_character(c) {
                Some(kind) => (Rule::Token(kind), 1),
                None => (Rule::Token(S_RAW_CHAR), 1),
            },
        }
    }

    fn match_obfuscation_marker(&self, p: usize) -> Option<(Rule, usize)> {
        let rest = &self.text[p..];
        let body = rest.strip_prefix(b"/*")?;
        for (name, kind) in OBFUSCATION_MARKERS {
            let Some(args) = body.strip_prefix(name) else { continue };
            let ok = args.len() >= 8
                && args[0] == b'('
                && args[1..5].iter().all(|c| c.is_ascii_digit() || (b'A'..=b'F').contains(c))
                && &args[5..8] == b")*/";
            if ok {
                return Some((Rule::ObfuscatedLiteral(kind), 2 + name.len() + 8));
            }
        }
        None
    }

    /// `{operator}` against the single- and two-character operator rules that come before it
    fn match_operator(&self, p: usize) -> (Rule, usize) {
        let length = self.run(p, is_op_char);
        let c = self.text[p];
        if length == 1 {
            return match special_character(c) {
                Some(kind) => (Rule::Token(kind), 1),
                None => (Rule::Operator, 1),
            };
        }
        if length == 2 {
            if let Some(kind) = two_char_operator(c, self.text[p + 1]) {
                return (Rule::Token(kind), 2);
            }
        }
        (Rule::Operator, length)
    }

    /// `{integer}`, `{decimal}`, `{decimalfail}`, `{real}`, `{realfail1}`, `{realfail2}`
    fn match_number(&self, p: usize) -> (Rule, usize) {
        let digits = self.run(p, |c| c.is_ascii_digit());
        let mut end = p + digits;
        let mut rule = Rule::Integer;
        if self.is(end, b'.') {
            if digits > 0 && self.is(end + 1, b'.') {
                return (Rule::Float { putback: 2 }, digits + 2);
            }
            end += 1 + self.run(end + 1, |c| c.is_ascii_digit());
            rule = Rule::Float { putback: 0 };
        }
        if matches!(self.at(end), Some(b'e' | b'E')) {
            let mut exponent = end + 1;
            let signed = matches!(self.at(exponent), Some(b'+' | b'-'));
            if signed {
                exponent += 1;
            }
            let exponent_digits = self.run(exponent, |c| c.is_ascii_digit());
            if exponent_digits > 0 {
                return (Rule::Float { putback: 0 }, exponent + exponent_digits - p);
            }
            let putback = if signed { 2 } else { 1 };
            return (Rule::Float { putback }, exponent - p);
        }
        (rule, end - p)
    }

    /// The rules of xc
    fn match_comment(&self, p: usize) -> (Rule, usize) {
        match self.text[p] {
            b'/' if self.is(p + 1, b'*') => (Rule::CommentStart, 2 + self.run(p + 2, is_op_char)),
            b'/' => (Rule::Skip, 1),
            b'*' => {
                let stars = self.run(p, |c| c == b'*');
                if self.is(p + stars, b'/') {
                    (Rule::CommentStop, stars + 1)
                } else {
                    (Rule::Skip, stars)
                }
            }
            _ => (Rule::Skip, self.run(p, |c| c != b'*' && c != b'/')),
        }
    }

    /// The rules of xb and xh
    fn match_bit_or_hex_string(&self, p: usize) -> (Rule, usize) {
        if self.text[p] != b'\'' {
            return (Rule::Skip, self.run(p, |c| c != b'\''));
        }
        let stop = self.quote_stop(p);
        let fail = self.quote_fail(p);
        let cont = self.quote_continue(p);
        // The longest match wins. {quotecontinue} never ties with {quotestop} or {quotefail}:
        // their last characters differ.
        let mut best = (Rule::QuoteStop, stop);
        if let Some(fail) = fail.filter(|&f| f > best.1) {
            best = (Rule::QuoteFail, fail);
        }
        if let Some(cont) = cont.filter(|&c| c > best.1) {
            best = (Rule::Skip, cont);
        }
        best
    }

    /// The rules of xq
    fn match_quoted_string(&self, p: usize) -> (Rule, usize) {
        if self.text[p] != b'\'' {
            return (Rule::Skip, self.run(p, |c| c != b'\''));
        }
        let mut best = (Rule::QuoteStop, self.quote_stop(p));
        if let Some(fail) = self.quote_fail(p).filter(|&f| f > best.1) {
            best = (Rule::QuoteFail, fail);
        }
        if self.is(p + 1, b'\'') && 2 > best.1 {
            best = (Rule::Skip, 2);
        }
        best
    }

    /// The rules of xd and xbt
    fn match_quoted_identifier(&self, p: usize, quote: u8) -> (Rule, usize) {
        if self.text[p] != quote {
            return (Rule::Skip, self.run(p, |c| c != quote));
        }
        if self.is(p + 1, quote) {
            (Rule::Skip, 2)
        } else {
            (Rule::IdentifierStop, 1)
        }
    }

    /// The end of a `--` comment that starts at `p`: the next newline or the end of the text
    fn comment_end(&self, p: usize) -> usize {
        p + 2 + self.run(p + 2, |c| !is_newline(c))
    }

    /// The positions reachable from `from` through `{whitespace}*`, as a bitmap starting at `from`
    fn whitespace_reach(&self, from: usize) -> Vec<bool> {
        let mut reach = vec![false; self.text.len() + 1 - from];
        reach[0] = true;
        let mut comment_covered = 0;
        for i in from..=self.text.len() {
            if !reach[i - from] {
                continue;
            }
            match self.at(i) {
                Some(c) if is_space(c) => reach[i + 1 - from] = true,
                Some(b'-') if self.is(i + 1, b'-') => {
                    let end = self.comment_end(i);
                    for j in (i + 2).max(comment_covered)..=end {
                        reach[j - from] = true;
                    }
                    comment_covered = comment_covered.max(end + 1);
                }
                _ => {}
            }
        }
        reach
    }

    /// The length of `{quotestop}` = `{quote}{whitespace}*` at `p`
    fn quote_stop(&self, p: usize) -> usize {
        let reach = self.whitespace_reach(p + 1);
        1 + reach.iter().rposition(|&r| r).unwrap()
    }

    /// The length of `{quotefail}` = `{quote}{whitespace}*"-"` at `p`
    fn quote_fail(&self, p: usize) -> Option<usize> {
        let reach = self.whitespace_reach(p + 1);
        (0..reach.len())
            .rev()
            .find(|&i| reach[i] && self.is(p + 1 + i, b'-'))
            .map(|i| 1 + i + 1)
    }

    /// The length of `{quotecontinue}` = `{quote}{whitespace_with_newline}{quote}` at `p`, where
    /// `{whitespace_with_newline}` = `{horiz_whitespace}*{newline}{special_whitespace}*`
    fn quote_continue(&self, p: usize) -> Option<usize> {
        let from = p + 1;
        let n = self.text.len() + 1 - from;
        // {horiz_whitespace}* = ({horiz_space}|{comment})*
        let mut horiz = vec![false; n];
        horiz[0] = true;
        for i in from..=self.text.len() {
            if !horiz[i - from] {
                continue;
            }
            match self.at(i) {
                Some(c) if is_horiz_space(c) => horiz[i + 1 - from] = true,
                Some(b'-') if self.is(i + 1, b'-') => {
                    for j in i + 2..=self.comment_end(i) {
                        horiz[j - from] = true;
                    }
                }
                _ => {}
            }
        }
        // {newline}
        let mut special = vec![false; n];
        for i in from..self.text.len() {
            if horiz[i - from] && is_newline(self.text[i]) {
                special[i + 1 - from] = true;
            }
        }
        // {special_whitespace}* = ({space}+|{comment}{newline})*
        for i in from..=self.text.len() {
            if !special[i - from] {
                continue;
            }
            match self.at(i) {
                Some(c) if is_space(c) => special[i + 1 - from] = true,
                Some(b'-') if self.is(i + 1, b'-') => {
                    let end = self.comment_end(i);
                    if end < self.text.len() {
                        special[end + 1 - from] = true;
                    }
                }
                _ => {}
            }
        }
        // {quote}
        (from..self.text.len())
            .rev()
            .find(|&i| special[i - from] && self.text[i] == b'\'')
            .map(|i| i + 1 - p)
    }
}

/// The C++ `AddObfuscatedLiteral`: derive an executable literal from the hash of a marker.
fn obfuscated_literal(text: &[u8], location: TextSpan) -> ObfuscatedLiteral {
    let marker = &text[location.offset as usize..location.end() as usize];
    let open = marker.iter().position(|&c| c == b'(').unwrap();
    let kind = &marker[2..open];
    let hash = std::str::from_utf8(&marker[open + 1..open + 5]).unwrap();
    let value = u32::from_str_radix(hash, 16).unwrap();
    let replacement = match kind {
        b"String" => format!("'{hash}'"),
        b"Integer" => value.to_string(),
        b"Float" => format!("{value}.0"),
        b"HexString" => format!("X'{hash}'"),
        _ => {
            let bits: String = (0..16).rev().map(|bit| if (value >> bit) & 1 == 1 { '1' } else { '0' }).collect();
            format!("B'{bits}'")
        }
    };
    ObfuscatedLiteral { location, replacement }
}

/// Names are cut out of valid UTF-8 at ASCII boundaries, so they are valid UTF-8 themselves.
fn utf8(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).expect("names are cut at ASCII boundaries")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(text: &str) -> Vec<SymbolKind> {
        scan(text, 0, 0).symbols.iter().map(|s| s.kind).collect()
    }

    fn spans(text: &str) -> Vec<(u32, u32)> {
        scan(text, 0, 0).symbols.iter().map(|s| (s.location.offset, s.location.length)).collect()
    }

    #[test]
    fn scans_keywords_and_identifiers() {
        let out = scan("SELECT Foo, foo", 0, 0);
        let kinds: Vec<_> = out.symbols.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, vec![S_SELECT, S_IDENT, S_COMMA, S_IDENT, S_YYEOF]);
        assert_eq!(out.symbols[0].value, SymbolValue::Text("select"));
        assert_eq!(out.symbols[1].value, SymbolValue::Name(0));
        assert_eq!(out.symbols[3].value, SymbolValue::Name(0));
        assert_eq!(out.names.get(0).text, "foo");
        assert_eq!(out.names.get(0).occurrences, 2);
        assert_eq!(out.symbols[4].location, TextSpan::new(15, 1));
    }

    #[test]
    fn scans_numbers() {
        assert_eq!(kinds("1..2"), vec![S_FCONST, S_DOT_DOT, S_ICONST, S_YYEOF]);
        assert_eq!(spans("1..2"), vec![(0, 1), (1, 2), (3, 1), (4, 1)]);
        assert_eq!(kinds("1e5 1.5 .5 1. 1e"), vec![S_FCONST, S_FCONST, S_FCONST, S_FCONST, S_FCONST, S_IDENT, S_YYEOF]);
    }

    #[test]
    fn scans_operators_like_the_cxx_scanner() {
        // The C++ operator rule keeps yyleng - nchars characters: "+--" yields a 2-byte PLUS.
        assert_eq!(kinds("+-- foo"), vec![S_PLUS, S_MINUS, S_IDENT, S_YYEOF]);
        assert_eq!(spans("+-- foo")[0], (0, 2));
        assert_eq!(kinds("=- <=> !="), vec![S_EQUALS, S_MINUS, S_Op, S_NOT_EQUALS, S_YYEOF]);
    }

    #[test]
    fn applies_the_lookahead_filter() {
        assert_eq!(kinds("not in"), vec![S_NOT_LA, S_IN_P, S_YYEOF]);
        assert_eq!(kinds("not foo"), vec![S_NOT, S_IDENT, S_YYEOF]);
        assert_eq!(kinds("a.*"), vec![S_IDENT, S_DOT_STAR_LA, S_STAR, S_YYEOF]);
        let out = scan("visualise using vegalite", 0, 0);
        assert_eq!(out.symbols[0].kind, S_VISUALIZE_LA);
        assert_eq!(out.symbols[0].value, SymbolValue::Text("visualise"));
    }

    #[test]
    fn scans_literals_and_comments() {
        let out = scan("'a' --c\n-1", 0, 0);
        assert_eq!(out.symbols[0].location, TextSpan::new(0, 3));
        // {quotefail} puts back the whitespace, its line break is counted twice.
        assert_eq!(out.line_breaks, vec![TextSpan::new(7, 1), TextSpan::new(7, 1)]);
        assert_eq!(out.comments, vec![TextSpan::new(4, 3)]);
        let out = scan("/* a /* b */ c */ 1", 0, 0);
        assert_eq!(out.comments, vec![TextSpan::new(0, 17)]);
        let out = scan("'unterminated", 0, 0);
        assert_eq!(out.errors[0].location, TextSpan::new(0, 14));
        assert_eq!(out.errors[0].message, "unterminated quoted string");
    }

    #[test]
    fn unescapes_quoted_identifiers() {
        let out = scan(r#"select "trailing""", """leading", "a""b", `trailing```, `` `a``b`"#, 0, 0);
        for name in ["trailing\"", "\"leading", "a\"b", "trailing`", "a`b"] {
            assert!(out.names.find(name).is_some(), "{name}");
        }
    }

    #[test]
    fn records_obfuscated_literals() {
        let out = scan("/*Integer(1A2B)*/", 0, 0);
        assert_eq!(out.symbols[0].kind, S_ICONST);
        assert_eq!(out.obfuscated_literals[0].replacement, "6699");
    }
}
