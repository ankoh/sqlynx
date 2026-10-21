//! The SQL scanner.
//!
//! A port of the flex scanner `grammar/scanner.l` that reproduces its output exactly, including its
//! quirks (docs/rust-port/quirks.md). The rules of every flex start condition are a logos lexer,
//! which matches like flex: the longest match wins, and ties go to the rule that comes first in
//! `scanner.l` (through logos priorities). The lexer of the current start condition matches one
//! token at a time, so that actions can switch the start condition and put text back with
//! `yyless`. Line breaks are recorded for every match before its action runs, so text that is put
//! back is counted again when it is scanned a second time, exactly like the C++ `YY_USER_ACTION`.
//!
//! [`scan`] then applies the lookahead filter of the C++ `Scanner::Scan`, which turns `NOT`, `NULLS`,
//! `WITH`, `.` and `VISUALIZE` into their `*_LA` variants depending on the following tokens.

use crate::keywords::{Keyword, KeywordCategory};
use crate::names::{NameId, NameRegistry};
use crate::span::TextSpan;
use crate::{symbol_kind::*, SymbolKind};
use logos::Logos;
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
        symbols: Vec::with_capacity(text.len() / 4 + 8),
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

// The rules of every start condition form a logos lexer. Logos takes the longest match like flex,
// and resolves a tie by priority where flex takes the rule that comes first in scanner.l. The
// default priority of a pattern is 2 for every byte or class it has to match, which already ranks
// `{comment}`, `{xcstart}` and the two-character operators above `{operator}`. The explicit
// priorities rank the remaining ties in the order of scanner.l.
//
// Like flex, the lexers match bytes, not characters (`utf8 = false` and byte-string patterns), so
// `\x80-\xFF` are identifier bytes.

/// The rules of INITIAL
#[derive(Logos, Clone, Copy, Debug, PartialEq, Eq)]
#[logos(utf8 = false)]
#[logos(subpattern space = br"[ \t\n\r\f]")]
#[logos(subpattern op_chars = br"[~!@#^&|+\-*/%<>=]")]
#[logos(subpattern integer = br"[0-9]+")]
#[logos(subpattern decimal = br"[0-9]*\.[0-9]+|[0-9]+\.[0-9]*")]
enum Initial {
    /// `{space}+`
    #[regex(br"(?&space)+")]
    Space,
    /// `{comment}`
    #[regex(br"--[^\n\r]*", allow_greedy = true)]
    Comment,
    /// The Hyper obfuscation markers, case-sensitive unlike the rest of scanner.l
    #[regex(br"/\*String\([0-9A-F]{4}\)\*/", |_| S_SCONST)]
    #[regex(br"/\*Integer\([0-9A-F]{4}\)\*/", |_| S_ICONST)]
    #[regex(br"/\*Float\([0-9A-F]{4}\)\*/", |_| S_FCONST)]
    #[regex(br"/\*HexString\([0-9A-F]{4}\)\*/", |_| S_XCONST)]
    #[regex(br"/\*BitString\([0-9A-F]{4}\)\*/", |_| S_BCONST)]
    ObfuscatedLiteral(SymbolKind),
    /// `{xcstart}`: matches as much as `{operator}` would, the action puts the operator back
    #[regex(br"/\*(?&op_chars)*")]
    CommentStart,
    /// `{xbstart}`, `{xhstart}`, `{xqstart}`, `{xdstart}`, `{xbtstart}`
    #[regex(b"[bB]'", |_| State::Xb)]
    #[regex(b"[xX]'", |_| State::Xh)]
    #[token("'", |_| State::Xq)]
    #[token("\"", |_| State::Xd)]
    #[token("`", |_| State::Xbt)]
    Begin(State),
    /// The operators and punctuation with a token of their own
    #[token("::", |_| S_TYPECAST)]
    #[token("..", |_| S_DOT_DOT)]
    #[token(".", |_| S_DOT)]
    #[token(":=", |_| S_COLON_EQUALS)]
    #[token("=>", |_| S_EQUALS_GREATER)]
    #[token("<=", |_| S_LESS_EQUALS)]
    #[token(">=", |_| S_GREATER_EQUALS)]
    #[token("<>", |_| S_NOT_EQUALS)]
    #[token("!=", |_| S_NOT_EQUALS)]
    #[token(",", |_| S_COMMA)]
    #[token("(", |_| S_LRB)]
    #[token(")", |_| S_RRB)]
    #[token("[", |_| S_LSB)]
    #[token("]", |_| S_RSB)]
    #[token("{", |_| S_LCB)]
    #[token("}", |_| S_RCB)]
    #[token(";", |_| S_SEMICOLON)]
    #[token(":", |_| S_COLON)]
    #[token("+", |_| S_PLUS)]
    #[token("-", |_| S_MINUS)]
    #[token("/", |_| S_DIVIDE)]
    #[token("*", |_| S_STAR)]
    #[token("%", |_| S_MODULO)]
    #[token("^", |_| S_CIRCUMFLEX)]
    #[token("&", |_| S_AMPERSAND)]
    #[token("|", |_| S_PIPE)]
    #[token("!", |_| S_EXCLAMATION_MARK)]
    #[token("<", |_| S_LESS_THAN)]
    #[token(">", |_| S_GREATER_THAN)]
    #[token("=", |_| S_EQUALS)]
    #[token("$", |_| S_DOLLAR)]
    Token(SymbolKind),
    /// `{raw_dot_trailing}`
    #[regex(br"\.(?&space)")]
    DotTrailing,
    /// `{raw_question_mark}`, the action checks the trailing context
    #[token("?")]
    QuestionMark,
    /// `{operator}`, below the single-character tokens
    #[regex(br"(?&op_chars)+", priority = 1)]
    Operator,
    /// `{integer}`
    #[regex(br"(?&integer)")]
    Integer,
    /// `{decimal}`, `{real}`
    #[regex(br"(?&decimal)")]
    #[regex(br"((?&integer)|(?&decimal))[Ee][-+]?[0-9]+")]
    Float,
    /// `{decimalfail}`
    #[regex(br"(?&integer)\.\.")]
    DecimalFail,
    /// `{realfail1}`
    #[regex(br"((?&integer)|(?&decimal))[Ee]")]
    RealFail1,
    /// `{realfail2}`
    #[regex(br"((?&integer)|(?&decimal))[Ee][-+]")]
    RealFail2,
    /// `{identifier}`
    #[regex(br"[A-Za-z\x80-\xFF_][A-Za-z\x80-\xFF_0-9$]*")]
    Identifier,
    /// `{other}`, below everything else
    #[regex(br"[^\n]", priority = 0)]
    Other,
}

/// The rules of xc
#[derive(Logos, Clone, Copy, Debug, PartialEq, Eq)]
#[logos(utf8 = false)]
enum Xc {
    /// `{xcstart}`
    #[regex(br"/\*[~!@#^&|+\-*/%<>=]*")]
    CommentStart,
    /// `{xcstop}`
    #[regex(br"\*+/")]
    CommentStop,
    /// `{xcinside}`, `{op_chars}`, `\*+`
    #[regex(br"[^*/]+")]
    #[regex(br"\*+")]
    #[token("/")]
    Inside,
}

/// The rules of xb and xh
#[derive(Logos, Clone, Copy, Debug, PartialEq, Eq)]
#[logos(utf8 = false)]
#[logos(subpattern whitespace = br"[ \t\n\r\f]|--[^\n\r]*")]
enum XbXh {
    /// `{quotestop}`
    #[regex(br"'(?&whitespace)*", allow_greedy = true)]
    QuoteStop,
    /// `{quotefail}`, below `{quotestop}`
    #[regex(br"'(?&whitespace)*-", allow_greedy = true, priority = 1)]
    QuoteFail,
    /// `{xbinside}`, `{xhinside}`, `{quotecontinue}`
    #[regex(br"[^']+")]
    #[regex(br"'([ \t\f]|--[^\n\r]*)*[\n\r]([ \t\n\r\f]|--[^\n\r]*[\n\r])*'", allow_greedy = true)]
    Inside,
}

/// The rules of xq
#[derive(Logos, Clone, Copy, Debug, PartialEq, Eq)]
#[logos(utf8 = false)]
#[logos(subpattern whitespace = br"[ \t\n\r\f]|--[^\n\r]*")]
enum Xq {
    /// `{quotestop}`
    #[regex(br"'(?&whitespace)*", allow_greedy = true)]
    QuoteStop,
    /// `{quotefail}`, below `{quotestop}`
    #[regex(br"'(?&whitespace)*-", allow_greedy = true, priority = 1)]
    QuoteFail,
    /// `{xqdouble}`, `{xqinside}`
    #[token("''")]
    #[regex(br"[^']+")]
    Inside,
}

/// The rules of xd
#[derive(Logos, Clone, Copy, Debug, PartialEq, Eq)]
#[logos(utf8 = false)]
enum Xd {
    /// `{xddouble}`, `{xdinside}`
    #[token("\"\"")]
    #[regex(br#"[^"]+"#)]
    Inside,
    /// `{xdstop}`
    #[token("\"")]
    Stop,
}

/// The rules of xbt
#[derive(Logos, Clone, Copy, Debug, PartialEq, Eq)]
#[logos(utf8 = false)]
enum Xbt {
    /// `{xbtdouble}`, `{xbtinside}`
    #[token("``")]
    #[regex(br"[^`]+")]
    Inside,
    /// `{xbtstop}`
    #[token("`")]
    Stop,
}

/// `{ident_cont}`
fn is_ident_cont(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
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

struct Lexer<'a> {
    text: &'a [u8],
    pos: usize,
    state: State,
    ext_begin: TextSpan,
    ext_depth: usize,
    /// A buffer for lower-casing and unescaping names
    buffer: Vec<u8>,
}

impl<'a> Lexer<'a> {
    fn new(text: &'a [u8]) -> Self {
        Self {
            text,
            pos: 0,
            state: State::Initial,
            ext_begin: TextSpan::default(),
            ext_depth: 0,
            buffer: Vec::with_capacity(64),
        }
    }

    fn span(begin: usize, length: usize) -> TextSpan {
        TextSpan::new(begin as u32, length as u32)
    }

    /// The location of the end-of-buffer match, which the EOF rules see
    fn eof_location(&self) -> TextSpan {
        Self::span(self.text.len(), 1)
    }

    /// Match the rules of a start condition at the current position and consume the match.
    ///
    /// Line breaks are recorded for the whole match before the action runs (`YY_USER_ACTION`), so
    /// text that the action puts back with `yyless` is counted again when it is scanned once more.
    fn next_match<T>(&mut self, out: &mut ScannedScript) -> (T, TextSpan)
    where
        T: Logos<'a, Source = [u8], Extras = ()>,
    {
        let start = self.pos;
        let mut lexer = T::lexer(&self.text[start..]);
        // Every byte starts a match in every start condition.
        let Some(Ok(token)) = lexer.next() else {
            unreachable!("no rule matches at {start}")
        };
        let length = lexer.span().end;
        for (i, &c) in self.text[start..start + length].iter().enumerate() {
            if c == b'\n' {
                out.line_breaks.push(Self::span(start + i, 1));
            }
        }
        self.pos = start + length;
        (token, Self::span(start, length))
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
            let symbol = match self.state {
                State::Initial => {
                    let (token, loc) = self.next_match::<Initial>(out);
                    self.initial(out, token, loc)
                }
                State::Xc => match self.next_match::<Xc>(out) {
                    (Xc::CommentStart, mut loc) => {
                        self.yyless(&mut loc, 2);
                        self.ext_depth += 1;
                        None
                    }
                    (Xc::CommentStop, loc) => {
                        self.ext_depth -= 1;
                        if self.ext_depth == 0 {
                            out.comments.push(self.ext_begin.cover(loc));
                            self.state = State::Initial;
                        }
                        None
                    }
                    (Xc::Inside, _) => None,
                },
                State::Xb | State::Xh => match self.next_match::<XbXh>(out) {
                    (XbXh::QuoteStop, loc) => Some(self.quote_stop(loc)),
                    (XbXh::QuoteFail, loc) => Some(self.quote_fail(loc)),
                    (XbXh::Inside, _) => None,
                },
                State::Xq => match self.next_match::<Xq>(out) {
                    (Xq::QuoteStop, loc) => Some(self.quote_stop(loc)),
                    (Xq::QuoteFail, loc) => Some(self.quote_fail(loc)),
                    (Xq::Inside, _) => None,
                },
                State::Xd => match self.next_match::<Xd>(out) {
                    (Xd::Stop, loc) => Some(self.identifier_stop(out, loc, b'"', "zero-length delimited identifier")),
                    (Xd::Inside, _) => None,
                },
                State::Xbt => match self.next_match::<Xbt>(out) {
                    (Xbt::Stop, loc) => {
                        Some(self.identifier_stop(out, loc, b'`', "zero-length backtick-quoted identifier"))
                    }
                    (Xbt::Inside, _) => None,
                },
            };
            if let Some(symbol) = symbol {
                return symbol;
            }
        }
    }

    /// Put back all but the first `n` characters of the current match (`yyless(n)`).
    fn yyless(&mut self, loc: &mut TextSpan, n: usize) {
        self.pos = loc.offset as usize + n;
        loc.length = n as u32;
    }

    /// Run the action of an INITIAL rule. Returns a symbol if the action returns one.
    fn initial(&mut self, out: &mut ScannedScript, token: Initial, mut loc: TextSpan) -> Option<Symbol> {
        match token {
            Initial::Space => None,
            Initial::Comment => {
                out.comments.push(loc);
                None
            }
            Initial::ObfuscatedLiteral(kind) => {
                out.obfuscated_literals.push(obfuscated_literal(self.text, loc));
                Some(Symbol::new(kind, loc))
            }
            Initial::CommentStart => {
                self.yyless(&mut loc, 2);
                self.ext_begin = loc;
                self.ext_depth += 1;
                self.state = State::Xc;
                None
            }
            Initial::Begin(state) => {
                self.ext_begin = loc;
                self.state = state;
                None
            }
            Initial::Token(kind) => Some(Symbol::new(kind, loc)),
            Initial::DotTrailing => Some(Symbol::new(S_DOT_TRAILING, TextSpan::new(loc.offset, 1))),
            // ?name, ?1 and ?"name" are named parameters, a standalone ? is a positional parameter
            Initial::QuestionMark => match self.text.get(self.pos) {
                Some(&c) if is_ident_cont(c) || c == b'"' => Some(Symbol::new(S_QUESTION_MARK, loc)),
                _ => Some(Symbol::new(S_PARAM, loc)),
            },
            Initial::Operator => Some(self.operator(out, loc)),
            // ReadInteger returns FCONST only if from_chars reports invalid_argument, which a digit
            // sequence never does (overflowing integers stay ICONST).
            Initial::Integer => Some(Symbol::new(S_ICONST, loc)),
            Initial::Float => Some(Symbol::new(S_FCONST, loc)),
            Initial::DecimalFail | Initial::RealFail1 | Initial::RealFail2 => {
                // Put back the dots, or the exponent marker and its sign
                let putback = if token == Initial::RealFail1 { 1 } else { 2 };
                let keep = loc.length as usize - putback;
                self.yyless(&mut loc, keep);
                Some(Symbol::new(S_FCONST, loc))
            }
            Initial::Identifier => Some(self.read_identifier(out, loc)),
            Initial::Other => Some(Symbol::new(S_RAW_CHAR, loc)),
        }
    }

    /// The `{quotestop}` action of xb, xh and xq
    fn quote_stop(&mut self, loc: TextSpan) -> Symbol {
        let kind = self.literal_kind();
        self.state = State::Initial;
        self.read_literal(kind, self.ext_begin.cover(loc))
    }

    /// The `{quotefail}` action of xb, xh and xq
    fn quote_fail(&mut self, mut loc: TextSpan) -> Symbol {
        let kind = self.literal_kind();
        let literal_end = TextSpan::new(loc.offset, 1);
        self.yyless(&mut loc, 1);
        self.state = State::Initial;
        self.read_literal(kind, self.ext_begin.cover(literal_end))
    }

    /// The `{xdstop}` and `{xbtstop}` actions
    fn identifier_stop(&mut self, out: &mut ScannedScript, loc: TextSpan, quote: u8, message: &str) -> Symbol {
        let loc = self.ext_begin.cover(loc);
        if loc.length == 2 {
            out.errors.push(ScannerError {
                location: loc,
                message: message.to_string(),
            });
        }
        self.state = State::Initial;
        self.read_quoted_identifier(out, loc, quote)
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

    fn read_quoted_identifier(&mut self, out: &mut ScannedScript, loc: TextSpan, quote: u8) -> Symbol {
        let text = &self.text[loc.offset as usize..loc.end() as usize];
        let inner = &text[1..text.len() - 1];
        let name = if inner.contains(&quote) {
            let name = &mut self.buffer;
            name.clear();
            let mut i = 0;
            while i < inner.len() {
                name.push(inner[i]);
                if inner[i] == quote && i + 1 < inner.len() && inner[i + 1] == quote {
                    i += 1;
                }
                i += 1;
            }
            &self.buffer[..]
        } else {
            inner
        };
        let id = out.names.register(utf8(name), loc);
        Symbol {
            kind: S_IDENT,
            location: loc,
            value: SymbolValue::Name(id),
        }
    }

    fn read_identifier(&mut self, out: &mut ScannedScript, loc: TextSpan) -> Symbol {
        let text = &self.text[loc.offset as usize..loc.end() as usize];
        self.buffer.clear();
        self.buffer.extend(text.iter().map(u8::to_ascii_lowercase));
        let lower = &self.buffer[..];
        if let Some(keyword) = Keyword::find(lower) {
            if keyword.category == KeywordCategory::VisUnreserved {
                out.names.register(keyword.name, loc);
            }
            return Symbol {
                kind: keyword.symbol,
                location: loc,
                value: SymbolValue::Text(keyword.name),
            };
        }
        let id = out.names.register(utf8(lower), loc);
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
fn utf8(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("names are cut at ASCII boundaries")
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
