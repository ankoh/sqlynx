//! The JSON document of a Hyper plan, read and written like rapidjson 1.1.0 does for the C++ plan view model.
//!
//! The C++ core parses plans in situ with `kParseCommentsFlag | kParseNanAndInfFlag | kParseTrailingCommasFlag |
//! kParseValidateEncodingFlag` and serializes attribute values with `rapidjson::Writer`. serde_json differs in
//! what it accepts (comments, NaN, trailing commas, lone surrogates), in duplicate keys, in number parsing (rapidjson
//! uses its imprecise fast path without `kParseFullPrecisionFlag`) and in number formatting (Grisu2), so this module
//! ports the parts of rapidjson the view model relies on:
//!
//! - the recursive descent reader (`GenericReader`), including the number fast path of 64 bit platforms
//! - the value types and accessors with rapidjson's number flags (`GenericValue`)
//! - the writer (`Writer<StringBuffer>`), which stops at NaN and infinity and leaves partial output behind
//!
//! The input is copied into a NUL-terminated buffer before parsing, so a NUL byte ends the input.
//!
//! The visualization port reads Vega-Lite specs with the same reader and the default flags
//! (`Document::parse_with(input, ParseFlags::DEFAULT)`).

use super::dtoa;
use std::sync::OnceLock;

/// The id of a value in a document
pub type ValueId = u32;

/// A JSON number, typed by the handler call of the rapidjson reader
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Number {
    /// `Handler::Int`, a negative value that fits into 32 bits
    Int(i32),
    /// `Handler::Uint`, a non-negative value that fits into 32 bits
    Uint(u32),
    /// `Handler::Int64`, a negative value that does not fit into 32 bits
    Int64(i64),
    /// `Handler::Uint64`, a non-negative value that does not fit into 32 bits
    Uint64(u64),
    /// `Handler::Double`
    Double(f64),
}

impl Number {
    /// `GenericValue::IsUint64`
    pub fn is_uint64(&self) -> bool {
        match *self {
            Number::Int(i) => i >= 0,
            Number::Int64(i) => i >= 0,
            Number::Uint(_) | Number::Uint64(_) => true,
            Number::Double(_) => false,
        }
    }

    /// The 64 bit storage of the value (`GenericValue::Number`)
    fn raw_bits(&self) -> u64 {
        match *self {
            Number::Int(i) => i as i64 as u64,
            Number::Uint(u) => u as u64,
            Number::Int64(i) => i as u64,
            Number::Uint64(u) => u,
            Number::Double(d) => d.to_bits(),
        }
    }

    /// `GenericValue::GetUint64`.
    ///
    /// For values that are not `IsUint64`, rapidjson asserts. Without assertions (release builds) the 64 bit
    /// storage is returned, which is what this function does.
    pub fn get_uint64(&self) -> u64 {
        self.raw_bits()
    }

    /// `GenericValue::GetUint`.
    ///
    /// For values that are not `IsUint`, rapidjson asserts. Without assertions (release builds) the lower 32 bits of
    /// the 64 bit storage are returned (little endian), which is what this function does.
    pub fn get_uint(&self) -> u32 {
        self.raw_bits() as u32
    }

    /// `GenericValue::GetDouble`
    pub fn get_double(&self) -> f64 {
        match *self {
            Number::Int(i) => i as f64,
            Number::Uint(u) => u as f64,
            Number::Int64(i) => i as f64,
            Number::Uint64(u) => u as f64,
            Number::Double(d) => d,
        }
    }
}

/// A JSON value
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(Number),
    /// The decoded string, may contain NUL bytes and (through `\u` escapes of lone low surrogates) invalid UTF-8
    String(Box<[u8]>),
    Array(Vec<ValueId>),
    Object(Vec<Member>),
}

/// A member of an object
#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    /// The decoded name
    pub name: Box<[u8]>,
    /// The value
    pub value: ValueId,
}

/// The prefix of a string up to the first NUL byte.
///
/// The C++ code often reads strings through `GetString()` as C strings, which truncates them at embedded NULs.
pub fn c_str(s: &[u8]) -> &[u8] {
    match s.iter().position(|b| *b == 0) {
        Some(n) => &s[..n],
        None => s,
    }
}

/// The `kParse*Flag`s of the reader that the C++ core uses
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseFlags {
    /// `kParseCommentsFlag`
    pub comments: bool,
    /// `kParseNanAndInfFlag`
    pub nan_and_inf: bool,
    /// `kParseTrailingCommasFlag`
    pub trailing_commas: bool,
    /// `kParseValidateEncodingFlag`
    pub validate_encoding: bool,
}

impl ParseFlags {
    /// `kParseDefaultFlags` (`GenericDocument::Parse` without flags)
    pub const DEFAULT: ParseFlags =
        ParseFlags { comments: false, nan_and_inf: false, trailing_commas: false, validate_encoding: false };
    /// The flags of the plan view model
    pub const PLAN: ParseFlags =
        ParseFlags { comments: true, nan_and_inf: true, trailing_commas: true, validate_encoding: true };
}

/// A parsed JSON document
#[derive(Clone, Debug, Default)]
pub struct Document {
    /// The values, the root is the last one
    values: Vec<Value>,
}

impl Document {
    /// Parse a document (`GenericDocument::ParseInsitu` with the flags of the plan view model).
    /// Returns `None` if rapidjson reports a parse error.
    pub fn parse(input: &[u8]) -> Option<Document> {
        Self::parse_with(input, ParseFlags::PLAN)
    }

    /// Parse a document with the given flags. Returns `None` if rapidjson reports a parse error.
    pub fn parse_with(input: &[u8], flags: ParseFlags) -> Option<Document> {
        // The input is copied into a NUL-terminated buffer, the reader stops at the first NUL
        let end = input.iter().position(|b| *b == 0).unwrap_or(input.len());
        let mut reader = Reader { src: &input[..end], pos: 0, values: Vec::new(), flags };
        reader.parse().ok()?;
        Some(Document { values: reader.values })
    }

    /// The root value
    pub fn root(&self) -> ValueId {
        (self.values.len() - 1) as ValueId
    }

    /// Get a value
    pub fn get(&self, id: ValueId) -> &Value {
        &self.values[id as usize]
    }

    /// The members of an object, empty for other values
    pub fn members(&self, id: ValueId) -> &[Member] {
        match self.get(id) {
            Value::Object(members) => members,
            _ => &[],
        }
    }

    /// `GenericValue::FindMember` (the first member with that name), `None` for other values than objects
    pub fn find_member(&self, id: ValueId, name: &[u8]) -> Option<ValueId> {
        self.members(id).iter().find(|m| &*m.name == name).map(|m| m.value)
    }

    pub fn is_object(&self, id: ValueId) -> bool {
        matches!(self.get(id), Value::Object(_))
    }

    pub fn is_array(&self, id: ValueId) -> bool {
        matches!(self.get(id), Value::Array(_))
    }

    /// The number of a value, if it is one (`IsNumber`)
    pub fn number(&self, id: ValueId) -> Option<Number> {
        match self.get(id) {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    /// The value as uint64 if `IsUint64`
    pub fn uint64(&self, id: ValueId) -> Option<u64> {
        self.number(id).filter(|n| n.is_uint64()).map(|n| n.get_uint64())
    }

    /// The string of a value, if it is one (`IsString`), with its full length
    pub fn string(&self, id: ValueId) -> Option<&[u8]> {
        match self.get(id) {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    /// Serialize a value with `rapidjson::Writer<StringBuffer>` (`value.Accept(writer)`).
    ///
    /// The writer fails at NaN and infinity, `Accept` then stops and the output written so far is returned.
    pub fn serialize(&self, id: ValueId) -> Vec<u8> {
        let mut writer = Writer { out: Vec::new(), levels: Vec::new() };
        writer.accept(self, id);
        writer.out
    }
}

/// A parse error, the C++ code only checks `HasParseError()`
struct ParseError;

type ParseResult<T> = Result<T, ParseError>;

/// The escapes of `ParseStringToStream`
fn unescape(c: u8) -> u8 {
    match c {
        b'"' => b'"',
        b'/' => b'/',
        b'\\' => b'\\',
        b'b' => 0x08,
        b'f' => 0x0C,
        b'n' => b'\n',
        b'r' => b'\r',
        b't' => b'\t',
        _ => 0,
    }
}

/// `UTF8::GetRange`, the DFA classes of http://bjoern.hoehrmann.de/utf-8/decoder/dfa/ with rapidjson's mapping
fn utf8_range(c: u8) -> u8 {
    match c {
        0x00..=0x7F => 0,
        0x80..=0x8F => 0x10,
        0x90..=0x9F => 0x40,
        0xA0..=0xBF => 0x20,
        0xC0..=0xC1 => 8,
        0xC2..=0xDF => 2,
        0xE0 => 10,
        0xE1..=0xEC => 3,
        0xED => 4,
        0xEE..=0xEF => 3,
        0xF0 => 11,
        0xF1..=0xF3 => 6,
        0xF4 => 5,
        0xF5..=0xFF => 8,
    }
}

/// `UTF8::Encode`
fn encode_utf8(out: &mut Vec<u8>, codepoint: u32) {
    if codepoint <= 0x7F {
        out.push(codepoint as u8);
    } else if codepoint <= 0x7FF {
        out.push(0xC0 | ((codepoint >> 6) & 0xFF) as u8);
        out.push(0x80 | (codepoint & 0x3F) as u8);
    } else if codepoint <= 0xFFFF {
        out.push(0xE0 | ((codepoint >> 12) & 0xFF) as u8);
        out.push(0x80 | ((codepoint >> 6) & 0x3F) as u8);
        out.push(0x80 | (codepoint & 0x3F) as u8);
    } else {
        out.push(0xF0 | ((codepoint >> 18) & 0xFF) as u8);
        out.push(0x80 | ((codepoint >> 12) & 0x3F) as u8);
        out.push(0x80 | ((codepoint >> 6) & 0x3F) as u8);
        out.push(0x80 | (codepoint & 0x3F) as u8);
    }
}

/// 1e0..1e308 (`internal::Pow10`), parsed like the C++ literals
fn pow10(n: i32) -> f64 {
    static TABLE: OnceLock<Vec<f64>> = OnceLock::new();
    let table = TABLE.get_or_init(|| (0..=308).map(|i| format!("1e{i}").parse::<f64>().unwrap()).collect());
    table[n as usize]
}

/// `internal::FastPath`
fn fast_path(significand: f64, exp: i32) -> f64 {
    if exp < -308 {
        0.0
    } else if exp >= 0 {
        significand * pow10(exp)
    } else {
        significand / pow10(-exp)
    }
}

/// `internal::StrtodNormalPrecision`
fn strtod_normal_precision(mut d: f64, p: i32) -> f64 {
    if p < -308 {
        // Prevent expSum < -308, making Pow10(p) = 0
        d = fast_path(d, -308);
        d = fast_path(d, p + 308);
    } else {
        d = fast_path(d, p);
    }
    d
}

fn is_digit(c: u8) -> bool {
    c.is_ascii_digit()
}

/// A port of `GenericReader` over an `InsituStringStream`, building the values like `GenericDocument`
struct Reader<'a> {
    /// The input up to the first NUL
    src: &'a [u8],
    /// The read position
    pos: usize,
    /// The values
    values: Vec<Value>,
    /// The parse flags
    flags: ParseFlags,
}

impl Reader<'_> {
    fn peek(&self) -> u8 {
        self.src.get(self.pos).copied().unwrap_or(0)
    }

    fn take(&mut self) -> u8 {
        let c = self.peek();
        self.pos += 1;
        c
    }

    fn consume(&mut self, expect: u8) -> bool {
        if self.peek() == expect {
            self.take();
            true
        } else {
            false
        }
    }

    fn push(&mut self, value: Value) -> ValueId {
        self.values.push(value);
        (self.values.len() - 1) as ValueId
    }

    /// `GenericReader::Parse`
    fn parse(&mut self) -> ParseResult<()> {
        self.skip_whitespace_and_comments()?;
        if self.peek() == 0 {
            return Err(ParseError); // kParseErrorDocumentEmpty
        }
        self.parse_value()?;
        self.skip_whitespace_and_comments()?;
        if self.peek() != 0 {
            return Err(ParseError); // kParseErrorDocumentRootNotSingular
        }
        Ok(())
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), b' ' | b'\n' | b'\r' | b'\t') {
            self.take();
        }
    }

    fn skip_whitespace_and_comments(&mut self) -> ParseResult<()> {
        self.skip_whitespace();
        if !self.flags.comments {
            return Ok(());
        }
        while self.consume(b'/') {
            if self.consume(b'*') {
                loop {
                    if self.peek() == 0 {
                        return Err(ParseError);
                    } else if self.consume(b'*') {
                        if self.consume(b'/') {
                            break;
                        }
                    } else {
                        self.take();
                    }
                }
            } else if self.consume(b'/') {
                while self.peek() != 0 && self.take() != b'\n' {}
            } else {
                return Err(ParseError);
            }
            self.skip_whitespace();
        }
        Ok(())
    }

    fn parse_value(&mut self) -> ParseResult<ValueId> {
        match self.peek() {
            b'n' => self.parse_literal(b"null", Value::Null),
            b't' => self.parse_literal(b"true", Value::Bool(true)),
            b'f' => self.parse_literal(b"false", Value::Bool(false)),
            b'"' => {
                let s = self.parse_string()?;
                Ok(self.push(Value::String(s.into_boxed_slice())))
            }
            b'{' => self.parse_object(),
            b'[' => self.parse_array(),
            _ => {
                let n = self.parse_number()?;
                Ok(self.push(Value::Number(n)))
            }
        }
    }

    /// `ParseNull`, `ParseTrue`, `ParseFalse`
    fn parse_literal(&mut self, literal: &[u8], value: Value) -> ParseResult<ValueId> {
        self.take();
        for c in &literal[1..] {
            if !self.consume(*c) {
                return Err(ParseError);
            }
        }
        Ok(self.push(value))
    }

    fn parse_object(&mut self) -> ParseResult<ValueId> {
        self.take(); // Skip '{'
        let mut members = Vec::new();
        self.skip_whitespace_and_comments()?;
        if self.consume(b'}') {
            return Ok(self.push(Value::Object(members)));
        }
        loop {
            if self.peek() != b'"' {
                return Err(ParseError);
            }
            let name = self.parse_string()?;
            self.skip_whitespace_and_comments()?;
            if !self.consume(b':') {
                return Err(ParseError);
            }
            self.skip_whitespace_and_comments()?;
            let value = self.parse_value()?;
            self.skip_whitespace_and_comments()?;
            members.push(Member { name: name.into_boxed_slice(), value });
            match self.peek() {
                b',' => {
                    self.take();
                    self.skip_whitespace_and_comments()?;
                }
                b'}' => {
                    self.take();
                    return Ok(self.push(Value::Object(members)));
                }
                _ => return Err(ParseError),
            }
            // kParseTrailingCommasFlag
            if self.flags.trailing_commas && self.peek() == b'}' {
                self.take();
                return Ok(self.push(Value::Object(members)));
            }
        }
    }

    fn parse_array(&mut self) -> ParseResult<ValueId> {
        self.take(); // Skip '['
        let mut elements = Vec::new();
        self.skip_whitespace_and_comments()?;
        if self.consume(b']') {
            return Ok(self.push(Value::Array(elements)));
        }
        loop {
            elements.push(self.parse_value()?);
            self.skip_whitespace_and_comments()?;
            if self.consume(b',') {
                self.skip_whitespace_and_comments()?;
            } else if self.consume(b']') {
                return Ok(self.push(Value::Array(elements)));
            } else {
                return Err(ParseError);
            }
            // kParseTrailingCommasFlag
            if self.flags.trailing_commas && self.peek() == b']' {
                self.take();
                return Ok(self.push(Value::Array(elements)));
            }
        }
    }

    /// `ParseHex4`
    fn parse_hex4(&mut self) -> ParseResult<u32> {
        let mut codepoint = 0u32;
        for _ in 0..4 {
            let c = self.peek();
            let digit = match c {
                b'0'..=b'9' => c - b'0',
                b'A'..=b'F' => c - b'A' + 10,
                b'a'..=b'f' => c - b'a' + 10,
                _ => return Err(ParseError),
            };
            codepoint = (codepoint << 4) + digit as u32;
            self.take();
        }
        Ok(codepoint)
    }

    /// `ParseString` with `ParseStringToStream`
    fn parse_string(&mut self) -> ParseResult<Vec<u8>> {
        self.take(); // Skip '"'
        let mut out = Vec::new();
        loop {
            let c = self.peek();
            if c == b'\\' {
                self.take();
                let e = self.peek();
                if unescape(e) != 0 {
                    self.take();
                    out.push(unescape(e));
                } else if e == b'u' {
                    self.take();
                    let mut codepoint = self.parse_hex4()?;
                    if (0xD800..=0xDBFF).contains(&codepoint) {
                        // Handle UTF-16 surrogate pair
                        if !self.consume(b'\\') || !self.consume(b'u') {
                            return Err(ParseError);
                        }
                        let codepoint2 = self.parse_hex4()?;
                        if !(0xDC00..=0xDFFF).contains(&codepoint2) {
                            return Err(ParseError);
                        }
                        codepoint = (((codepoint - 0xD800) << 10) | (codepoint2 - 0xDC00)) + 0x10000;
                    }
                    encode_utf8(&mut out, codepoint);
                } else {
                    return Err(ParseError);
                }
            } else if c == b'"' {
                self.take();
                return Ok(out);
            } else if c < 0x20 {
                // kParseErrorStringMissQuotationMark or kParseErrorStringEscapeInvalid
                return Err(ParseError);
            } else if !self.flags.validate_encoding {
                // `Transcoder<UTF8, UTF8>::Transcode` copies the code unit
                out.push(self.take());
            } else if !self.validate_utf8(&mut out) {
                return Err(ParseError);
            }
        }
    }

    /// `UTF8::Validate`: copy one code point and check its encoding
    fn validate_utf8(&mut self, out: &mut Vec<u8>) -> bool {
        let c = self.take();
        out.push(c);
        if c & 0x80 == 0 {
            return true;
        }
        // The masks of the following bytes: COPY(); TRANS(mask) per byte, TAIL() is TRANS(0x70)
        let masks: &[u8] = match utf8_range(c) {
            2 => &[0x70],
            3 => &[0x70, 0x70],
            4 => &[0x50, 0x70],
            5 => &[0x10, 0x70, 0x70],
            6 => &[0x70, 0x70, 0x70],
            10 => &[0x20, 0x70],
            11 => &[0x60, 0x70, 0x70],
            _ => return false,
        };
        let mut result = true;
        for mask in masks {
            let c = self.take();
            out.push(c);
            result &= (utf8_range(c) & mask) != 0;
        }
        result
    }

    /// `ParseNumber` without `kParseFullPrecisionFlag` on a 64 bit platform (`RAPIDJSON_64BIT`)
    fn parse_number(&mut self) -> ParseResult<Number> {
        let mut d = 0.0f64;
        let mut use_nan_or_inf = false;

        // Parse minus
        let minus = self.consume(b'-');

        // Parse int: zero / ( digit1-9 *DIGIT )
        let mut i: u32 = 0;
        let mut i64: u64 = 0;
        let mut use64bit = false;
        let mut significand_digit: i32 = 0;
        if self.peek() == b'0' {
            i = 0;
            self.take();
        } else if (b'1'..=b'9').contains(&self.peek()) {
            i = (self.take() - b'0') as u32;
            if minus {
                while is_digit(self.peek()) {
                    if i >= 214748364 {
                        // 2^31 = 2147483648
                        if i != 214748364 || self.peek() > b'8' {
                            i64 = i as u64;
                            use64bit = true;
                            break;
                        }
                    }
                    i = i * 10 + (self.take() - b'0') as u32;
                    significand_digit += 1;
                }
            } else {
                while is_digit(self.peek()) {
                    if i >= 429496729 {
                        // 2^32 - 1 = 4294967295
                        if i != 429496729 || self.peek() > b'5' {
                            i64 = i as u64;
                            use64bit = true;
                            break;
                        }
                    }
                    i = i * 10 + (self.take() - b'0') as u32;
                    significand_digit += 1;
                }
            }
        }
        // Parse NaN or Infinity here
        else if self.flags.nan_and_inf && (self.peek() == b'I' || self.peek() == b'N') {
            use_nan_or_inf = true;
            if self.consume(b'N') && self.consume(b'a') && self.consume(b'N') {
                d = f64::NAN;
            } else if self.consume(b'I') && self.consume(b'n') && self.consume(b'f') {
                d = if minus { f64::NEG_INFINITY } else { f64::INFINITY };
                if self.peek() == b'i'
                    && !(self.consume(b'i')
                        && self.consume(b'n')
                        && self.consume(b'i')
                        && self.consume(b't')
                        && self.consume(b'y'))
                {
                    return Err(ParseError);
                }
            } else {
                return Err(ParseError);
            }
        } else {
            return Err(ParseError);
        }

        // Parse 64bit int
        let mut use_double = false;
        if use64bit {
            if minus {
                while is_digit(self.peek()) {
                    if i64 >= 0x0CCC_CCCC_CCCC_CCCC {
                        // 2^63 = 9223372036854775808
                        if i64 != 0x0CCC_CCCC_CCCC_CCCC || self.peek() > b'8' {
                            d = i64 as f64;
                            use_double = true;
                            break;
                        }
                    }
                    i64 = i64 * 10 + (self.take() - b'0') as u64;
                    significand_digit += 1;
                }
            } else {
                while is_digit(self.peek()) {
                    if i64 >= 0x1999_9999_9999_9999 {
                        // 2^64 - 1 = 18446744073709551615
                        if i64 != 0x1999_9999_9999_9999 || self.peek() > b'5' {
                            d = i64 as f64;
                            use_double = true;
                            break;
                        }
                    }
                    i64 = i64 * 10 + (self.take() - b'0') as u64;
                    significand_digit += 1;
                }
            }
        }

        // Force double for big integer
        if use_double {
            while is_digit(self.peek()) {
                if d >= 1.7976931348623157e307 {
                    // DBL_MAX / 10.0
                    return Err(ParseError); // kParseErrorNumberTooBig
                }
                d = d * 10.0 + (self.take() - b'0') as f64;
            }
        }

        // Parse frac = decimal-point 1*DIGIT
        let mut exp_frac: i32 = 0;
        if self.consume(b'.') {
            if !is_digit(self.peek()) {
                return Err(ParseError); // kParseErrorNumberMissFraction
            }
            if !use_double {
                // Use i64 to store significand in 64-bit architecture
                if !use64bit {
                    i64 = i as u64;
                }
                while is_digit(self.peek()) {
                    if i64 > 0x1F_FFFF_FFFF_FFFF {
                        // 2^53 - 1 for fast path
                        break;
                    } else {
                        i64 = i64 * 10 + (self.take() - b'0') as u64;
                        exp_frac -= 1;
                        if i64 != 0 {
                            significand_digit += 1;
                        }
                    }
                }
                d = i64 as f64;
                use_double = true;
            }
            while is_digit(self.peek()) {
                if significand_digit < 17 {
                    d = d * 10.0 + (self.take() - b'0') as f64;
                    exp_frac -= 1;
                    if d > 0.0 {
                        significand_digit += 1;
                    }
                } else {
                    self.take();
                }
            }
        }

        // Parse exp = e [ minus / plus ] 1*DIGIT
        let mut exp: i32 = 0;
        if self.consume(b'e') || self.consume(b'E') {
            if !use_double {
                d = if use64bit { i64 as f64 } else { i as f64 };
                use_double = true;
            }
            let mut exp_minus = false;
            if self.consume(b'+') {
            } else if self.consume(b'-') {
                exp_minus = true;
            }
            if is_digit(self.peek()) {
                exp = (self.take() - b'0') as i32;
                if exp_minus {
                    while is_digit(self.peek()) {
                        exp = exp.wrapping_mul(10).wrapping_add((self.take() - b'0') as i32);
                        if exp >= 214748364 {
                            // Issue #313: prevent overflow exponent
                            while is_digit(self.peek()) {
                                self.take();
                            }
                        }
                    }
                } else {
                    let max_exp = 308 - exp_frac;
                    while is_digit(self.peek()) {
                        exp = exp.wrapping_mul(10).wrapping_add((self.take() - b'0') as i32);
                        if exp > max_exp {
                            return Err(ParseError); // kParseErrorNumberTooBig
                        }
                    }
                }
            } else {
                return Err(ParseError); // kParseErrorNumberMissExponent
            }
            if exp_minus {
                exp = -exp;
            }
        }

        // Finish parsing, call event according to the type of number.
        if use_double {
            let p = exp + exp_frac;
            d = strtod_normal_precision(d, p);
            Ok(Number::Double(if minus { -d } else { d }))
        } else if use_nan_or_inf {
            Ok(Number::Double(d))
        } else if use64bit {
            if minus {
                Ok(Number::Int64((!i64).wrapping_add(1) as i64))
            } else {
                Ok(Number::Uint64(i64))
            }
        } else if minus {
            Ok(Number::Int((!i).wrapping_add(1) as i32))
        } else {
            Ok(Number::Uint(i))
        }
    }
}

/// `Writer::WriteString` with the default flags: escapes control characters, quotes and backslashes and copies
/// all other bytes without validation
pub(crate) fn write_string(out: &mut Vec<u8>, s: &[u8]) {
    const HEX_DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    out.push(b'"');
    for &c in s {
        let escape = match c {
            0x08 => b'b',
            0x09 => b't',
            0x0A => b'n',
            0x0C => b'f',
            0x0D => b'r',
            0x00..=0x1F => b'u',
            b'"' => b'"',
            b'\\' => b'\\',
            _ => 0,
        };
        if escape != 0 {
            out.push(b'\\');
            out.push(escape);
            if escape == b'u' {
                out.extend_from_slice(b"00");
                out.push(HEX_DIGITS[(c >> 4) as usize]);
                out.push(HEX_DIGITS[(c & 0xF) as usize]);
            }
        } else {
            // UTF-8 to UTF-8 without validation copies the code unit
            out.push(c);
        }
    }
    out.push(b'"');
}

/// A nesting level of the writer
struct Level {
    in_array: bool,
    value_count: usize,
}

/// A port of `rapidjson::Writer<StringBuffer>` with the default flags
struct Writer {
    out: Vec<u8>,
    levels: Vec<Level>,
}

impl Writer {
    fn prefix(&mut self) {
        if let Some(level) = self.levels.last_mut() {
            if level.value_count > 0 {
                if level.in_array {
                    self.out.push(b','); // add comma if it is not the first element in array
                } else {
                    // in object
                    self.out.push(if level.value_count % 2 == 0 { b',' } else { b':' });
                }
            }
            level.value_count += 1;
        }
    }

    /// `WriteString`
    fn write_string(&mut self, s: &[u8]) {
        write_string(&mut self.out, s);
    }

    /// `GenericValue::Accept`
    fn accept(&mut self, doc: &Document, id: ValueId) -> bool {
        match doc.get(id) {
            Value::Null => {
                self.prefix();
                self.out.extend_from_slice(b"null");
                true
            }
            Value::Bool(b) => {
                self.prefix();
                self.out.extend_from_slice(if *b { b"true" } else { b"false" });
                true
            }
            Value::Number(n) => {
                self.prefix();
                match *n {
                    Number::Double(d) => {
                        if dtoa::is_nan_or_inf(d) {
                            return false;
                        }
                        dtoa::dtoa(d, &mut self.out);
                    }
                    Number::Int(i) => self.out.extend_from_slice(i.to_string().as_bytes()),
                    Number::Uint(u) => self.out.extend_from_slice(u.to_string().as_bytes()),
                    Number::Int64(i) => self.out.extend_from_slice(i.to_string().as_bytes()),
                    Number::Uint64(u) => self.out.extend_from_slice(u.to_string().as_bytes()),
                }
                true
            }
            Value::String(s) => {
                self.prefix();
                self.write_string(s);
                true
            }
            Value::Object(members) => {
                self.prefix();
                self.out.push(b'{');
                self.levels.push(Level { in_array: false, value_count: 0 });
                for member in members {
                    self.prefix();
                    self.write_string(&member.name);
                    if !self.accept(doc, member.value) {
                        return false;
                    }
                }
                self.levels.pop();
                self.out.push(b'}');
                true
            }
            Value::Array(elements) => {
                self.prefix();
                self.out.push(b'[');
                self.levels.push(Level { in_array: true, value_count: 0 });
                for element in elements {
                    if !self.accept(doc, *element) {
                        return false;
                    }
                }
                self.levels.pop();
                self.out.push(b']');
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(input: &str) -> Option<String> {
        let doc = Document::parse(input.as_bytes())?;
        Some(String::from_utf8_lossy(&doc.serialize(doc.root())).into_owned())
    }

    #[test]
    fn parses_relaxed_json() {
        assert_eq!(roundtrip(r#"{"a":[1,2,],}"#).as_deref(), Some(r#"{"a":[1,2]}"#));
        assert_eq!(roundtrip("/* c */ [1, // x\n 2] // y").as_deref(), Some("[1,2]"));
        assert_eq!(roundtrip(r#"{"a":1,"a":2}"#).as_deref(), Some(r#"{"a":1,"a":2}"#));
        assert_eq!(roundtrip("[1]\0garbage").as_deref(), Some("[1]"));
        assert_eq!(roundtrip(""), None);
        assert_eq!(roundtrip("[1] x"), None);
        assert_eq!(roundtrip("[1,,]"), None);
        assert_eq!(roundtrip("/ [1]"), None);
        assert_eq!(roundtrip("/* [1]"), None);
        assert_eq!(roundtrip("\"\\x\""), None);
        assert_eq!(roundtrip("\"\u{1}\""), None);
        assert_eq!(roundtrip("\"\\ud800\""), None);
        // A lone low surrogate is encoded as is, which is invalid UTF-8
        let doc = Document::parse(b"\"\\udc00\"").unwrap();
        assert_eq!(doc.string(doc.root()), Some(&b"\xed\xb0\x80"[..]));
        assert_eq!(Document::parse(b"\"\xff\"").is_none(), true);
        assert_eq!(Document::parse(b"\"\xc0\x80\"").is_none(), true);
    }

    #[test]
    fn parses_with_default_flags() {
        let parse = |input: &[u8]| Document::parse_with(input, ParseFlags::DEFAULT);
        assert!(parse(br#"{"a":[1,2]}"#).is_some());
        assert!(parse(br#"{"a":[1,2,]}"#).is_none());
        assert!(parse(br#"{"a":1,}"#).is_none());
        assert!(parse(b"[1] // c").is_none());
        assert!(parse(b"[NaN]").is_none());
        assert!(parse(b"[Infinity]").is_none());
        // Without validation, invalid UTF-8 is copied
        let doc = parse(b"\"\xff\xc0\x80\"").unwrap();
        assert_eq!(doc.string(doc.root()), Some(&b"\xff\xc0\x80"[..]));
    }

    #[test]
    fn writes_like_rapidjson() {
        assert_eq!(roundtrip(r#""a\u0000b\u001f\/\"""#).as_deref(), Some(r#""a\u0000b\u001F/\"""#));
        assert_eq!(roundtrip("[-0, -0.0, 1.5e3, 1e400]"), None);
        assert_eq!(roundtrip("[-0, -0.0, 1.5e3, 0.1]").as_deref(), Some("[0,-0.0,1500.0,0.1]"));
        assert_eq!(roundtrip("[1, NaN, 2]").as_deref(), Some("[1,"));
        assert_eq!(roundtrip(r#"{"a":Infinity}"#).as_deref(), Some(r#"{"a":"#));
        assert_eq!(roundtrip("-Inf").as_deref(), Some(""));
        assert_eq!(roundtrip("NaN.5").as_deref(), Some("0.5"));
        // Grisu2 does not find the shortest digits for 2^64
        assert_eq!(
            roundtrip("[18446744073709551615, 18446744073709551616]").as_deref(),
            Some("[18446744073709551615,18446744073709553000.0]")
        );
        assert_eq!(roundtrip("[-2147483648, -2147483649]").as_deref(), Some("[-2147483648,-2147483649]"));
    }
}
