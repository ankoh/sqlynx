//! A port of the YAML emitter of rapidyaml 0.12.1 (`c4/yml/emit.def.hpp`), for trees without anchors, tags and
//! documents, with the default emit options.

use super::{ContainerStyle, Node, Scalar, ScalarStyle};

/// Pending whitespace
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pws {
    None,
    Space,
    Newline,
}

struct Emitter {
    out: String,
    ilevel: usize,
    pws: Pws,
}

/// Emit a mapping entry together with its key, like rapidyaml emits a non-root node (`emitrs_yaml(node)`).
pub fn emit_entry(key: &Scalar, value: &Node) -> String {
    let mut e = Emitter::new();
    e.blck_map_open_entry(key, value);
    e.ilevel += 1;
    match value {
        Node::Scalar(s) => e.visit_doc_val(s),
        container => e.visit_blck_container(container),
    }
    e.ilevel -= 1;
    e.pend(Pws::Newline);
    if container_style(value) == Some(ContainerStyle::FlowMultiline) {
        e.newl();
    } else {
        e.write_pws_and_pend(Pws::None);
    }
    e.out
}

/// Emit a root node (`emitrs_yaml(tree.rootref())`)
pub fn emit_root(root: &Node) -> String {
    let mut e = Emitter::new();
    match root {
        Node::Scalar(s) => {
            e.visit_doc_val(s);
            if s.text.is_some() {
                e.pend(Pws::Newline);
            }
        }
        container => e.visit_blck_container(container),
    }
    if container_style(root) == Some(ContainerStyle::FlowMultiline) {
        e.newl();
    } else {
        e.write_pws_and_pend(Pws::None);
    }
    e.out
}

/// The post-processing of the C++ snapshotter (`InjectBlankLinesInSnapshot`): a blank line before every entry of
/// the top-level sequence, and no trailing spaces.
pub fn inject_blank_lines(yaml: &mut String) {
    let spaced = yaml.replace("\n  - ", "\n\n  - ");
    let mut out = String::with_capacity(spaced.len());
    for (i, line) in spaced.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(line.trim_end_matches(' '));
    }
    *yaml = out;
}

fn container_style(node: &Node) -> Option<ContainerStyle> {
    match node {
        Node::Seq(_, style) | Node::Map(_, style) => Some(*style),
        Node::Scalar(_) => None,
    }
}

fn is_empty(node: &Node) -> bool {
    match node {
        Node::Seq(items, _) => items.is_empty(),
        Node::Map(entries, _) => entries.is_empty(),
        Node::Scalar(_) => true,
    }
}

/// `scalar_style_choose`
pub(super) fn scalar_style_choose(s: Option<&str>) -> ScalarStyle {
    match s {
        None => ScalarStyle::Plain,
        Some("") => ScalarStyle::SingleQuoted,
        Some(s) => {
            let ws = |c: char| matches!(c, ' ' | '\n' | '\t');
            if s.starts_with(ws) || s.ends_with(ws) {
                ScalarStyle::DoubleQuoted
            } else if !scalar_style_query_plain(s) {
                if scalar_style_query_squo(s) {
                    ScalarStyle::SingleQuoted
                } else {
                    ScalarStyle::DoubleQuoted
                }
            } else {
                ScalarStyle::Plain
            }
        }
    }
}

/// `scalar_style_query_squo`
fn scalar_style_query_squo(s: &str) -> bool {
    !s.contains("\n ") && !s.contains("\n\t")
}

/// `scalar_style_query_plain`
fn scalar_style_query_plain(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix("-.") {
        if s == "-.inf" || s == "-.INF" || is_number(rest) {
            return true;
        }
    } else if s.starts_with(|c: char| "0123456789.-+".contains(c)) && is_number(s) {
        return true;
    }
    !s.starts_with(|c: char| "-:?*&,'\"{}[]|>%#@`\r".contains(c))
        && !s.ends_with([':', '#'])
        && !s.contains(['\n', '#', ':', '[', ']', '{', '}', ','])
}

/// `csubstr::is_number`: an integer or a real number, without surrounding whitespace
fn is_number(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.iter().any(|c| matches!(c, b' ' | b'\n' | b'\r' | b'\t')) {
        return false;
    }
    is_integer(b) || is_real(b)
}

fn digits_in(b: &[u8], valid: impl Fn(u8) -> bool) -> bool {
    b.iter().all(|&c| valid(c))
}

fn is_integer(b: &[u8]) -> bool {
    let skip = usize::from(b[0] == b'+' || b[0] == b'-');
    if skip == b.len() {
        return false;
    }
    if b.len() >= skip + 3 && b[skip] == b'0' {
        let rest = &b[skip + 2..];
        match b[skip + 1] {
            b'x' | b'X' => return digits_in(rest, |c| c.is_ascii_hexdigit()),
            b'b' | b'B' => return digits_in(rest, |c| c == b'0' || c == b'1'),
            b'o' | b'O' => return digits_in(rest, |c| (b'0'..=b'7').contains(&c)),
            _ => {}
        }
    }
    digits_in(&b[skip..], |c| c.is_ascii_digit())
}

fn is_real(b: &[u8]) -> bool {
    let skip = usize::from(b[0] == b'+' || b[0] == b'-');
    let rest = &b[skip..];
    if b.len() >= skip + 3 {
        if rest[0] != b'0' {
            return match rest[0] {
                b'i' => rest == b"infinity" || rest == b"inf",
                b'n' => rest == b"nan",
                _ => is_real_with(rest, |c| c.is_ascii_digit(), b"eE", false),
            };
        }
        match rest[1] {
            b'x' | b'X' => return is_real_with(&rest[2..], |c| c.is_ascii_hexdigit(), b"pP", true),
            b'b' | b'B' => return is_real_with(&rest[2..], |c| c == b'0' || c == b'1', b"pP", true),
            b'o' | b'O' => return is_real_with(&rest[2..], |c| (b'0'..=b'7').contains(&c), b"pP", true),
            _ => {}
        }
    }
    is_real_with(rest, |c| c.is_ascii_digit(), b"eE", false)
}

/// `_first_real_span_{dec,hex,bin,oct}` spanning the whole text
fn is_real_with(b: &[u8], digit: impl Fn(u8) -> bool, exp: &[u8], signed_exp: bool) -> bool {
    let mut pos = 0;
    let mut int_chars = false;
    let mut frac_chars = false;
    while pos < b.len() && digit(b[pos]) {
        int_chars = true;
        pos += 1;
    }
    if pos < b.len() && b[pos] == b'.' {
        pos += 1;
        while pos < b.len() && digit(b[pos]) {
            frac_chars = true;
            pos += 1;
        }
    }
    if pos == b.len() {
        return int_chars || frac_chars;
    }
    if !exp.contains(&b[pos]) {
        return false;
    }
    pos += 1;
    if pos == b.len() || !(int_chars || frac_chars) {
        return false;
    }
    if signed_exp {
        if pos + 1 >= b.len() || (b[pos] != b'+' && b[pos] != b'-') {
            return false;
        }
        pos += 1;
    } else if b[pos] == b'+' || b[pos] == b'-' {
        pos += 1;
    }
    pos < b.len() && b[pos..].iter().all(u8::is_ascii_digit)
}

impl Emitter {
    fn new() -> Self {
        Self { out: String::new(), ilevel: 0, pws: Pws::None }
    }

    fn write(&mut self, s: &str) {
        self.out.push_str(s);
    }

    fn indent(&mut self, level: usize) {
        for _ in 0..2 * level {
            self.out.push(' ');
        }
    }

    fn newl(&mut self) {
        self.out.push('\n');
    }

    fn pend(&mut self, pws: Pws) {
        self.pws = pws;
    }

    fn write_pws_and_pend(&mut self, next: Pws) {
        match self.pws {
            Pws::Space => self.write(" "),
            Pws::Newline => {
                self.newl();
                self.indent(self.ilevel);
            }
            Pws::None => {}
        }
        self.pws = next;
    }

    fn visit_doc_val(&mut self, s: &Scalar) {
        let text = s.as_str();
        let ambiguous = matches!(s.style, ScalarStyle::Plain | ScalarStyle::Auto)
            && (text.starts_with("...") || text.starts_with("---"));
        if ambiguous {
            self.ilevel += 1;
            if self.pws != Pws::None {
                self.pend(Pws::Newline);
            } else {
                self.indent(self.ilevel);
            }
        }
        self.write_pws_and_pend(Pws::None);
        // An unset style stays unset here (`_blck_write_scalar(val, val_style)`), which writes a plain scalar
        let style = match s.style {
            ScalarStyle::Auto => ScalarStyle::Plain,
            style => style,
        };
        self.blck_write_scalar(text, style);
        if ambiguous {
            self.ilevel -= 1;
        }
    }

    fn visit_blck_container(&mut self, node: &Node) {
        let style = match container_style(node).unwrap() {
            ContainerStyle::Auto if is_empty(node) => ContainerStyle::Flow,
            ContainerStyle::Auto => ContainerStyle::Block,
            style => style,
        };
        self.write_pws_and_pend(Pws::None);
        match style {
            ContainerStyle::Flow => self.visit_flow_sl(node),
            ContainerStyle::FlowMultiline => self.visit_flow_ml(node),
            _ => self.visit_blck(node),
        }
    }

    fn visit_flow_container(&mut self, node: &Node) {
        self.write_pws_and_pend(Pws::None);
        match container_style(node).unwrap() {
            ContainerStyle::FlowMultiline => self.visit_flow_ml(node),
            _ => self.visit_flow_sl(node),
        }
    }

    fn blck_seq_open_entry(&mut self) {
        self.write_pws_and_pend(Pws::None);
        self.write_pws_and_pend(Pws::Space);
        self.write("-");
    }

    fn blck_map_open_entry(&mut self, key: &Scalar, value: &Node) {
        let key_style = match key.style {
            ScalarStyle::Auto => scalar_style_choose(key.text.as_deref()),
            style => style,
        };
        self.write_pws_and_pend(Pws::None);
        self.write_pws_and_pend(Pws::None);
        if matches!(key_style, ScalarStyle::Literal | ScalarStyle::Folded) {
            self.write("? ");
            self.blck_write_scalar(key.as_str(), key_style);
            self.pend(Pws::Newline);
        } else {
            self.blck_write_scalar(key.as_str(), key_style);
        }
        self.write_pws_and_pend(Pws::Space);
        self.write(":");
        if let Some(style) = container_style(value) {
            if !is_empty(value) && matches!(style, ContainerStyle::Auto | ContainerStyle::Block) {
                self.pend(Pws::Newline);
            }
        }
    }

    /// The style of a value in block context
    fn blck_val_style(s: &Scalar) -> ScalarStyle {
        match s.style {
            ScalarStyle::Auto => scalar_style_choose(s.text.as_deref()),
            style => style,
        }
    }

    /// The style of a scalar in flow context, block styles are not allowed there
    fn flow_val_style(s: &Scalar) -> ScalarStyle {
        match s.style {
            ScalarStyle::Plain | ScalarStyle::SingleQuoted | ScalarStyle::DoubleQuoted => s.style,
            _ => scalar_style_choose(s.text.as_deref()),
        }
    }

    fn visit_blck(&mut self, node: &Node) {
        match node {
            Node::Seq(items, _) => {
                for item in items {
                    self.blck_seq_open_entry();
                    match item {
                        Node::Scalar(s) => {
                            self.write_pws_and_pend(Pws::None);
                            self.blck_write_scalar(s.as_str(), Self::blck_val_style(s));
                        }
                        container => {
                            self.ilevel += 1;
                            self.visit_blck_container(container);
                            self.ilevel -= 1;
                        }
                    }
                    self.pend(Pws::Newline);
                }
                if items.is_empty() {
                    self.write_pws_and_pend(Pws::None);
                    self.write("[]");
                }
            }
            Node::Map(entries, _) => {
                for (key, value) in entries {
                    self.blck_map_open_entry(key, value);
                    match value {
                        Node::Scalar(s) => {
                            self.write_pws_and_pend(Pws::None);
                            self.blck_write_scalar(s.as_str(), Self::blck_val_style(s));
                        }
                        container => {
                            self.ilevel += 1;
                            self.visit_blck_container(container);
                            self.ilevel -= 1;
                        }
                    }
                    self.pend(Pws::Newline);
                }
                if entries.is_empty() {
                    self.write_pws_and_pend(Pws::None);
                    self.write("{}");
                }
            }
            Node::Scalar(_) => unreachable!(),
        }
    }

    fn flow_map_key(&mut self, key: &Scalar) {
        self.write_pws_and_pend(Pws::None);
        self.write_pws_and_pend(Pws::None);
        let style = Self::flow_val_style(key);
        self.flow_write_scalar(key.as_str(), style);
        self.write_pws_and_pend(Pws::Space);
        self.write(":");
    }

    fn flow_value(&mut self, value: &Node) {
        match value {
            Node::Scalar(s) => {
                self.write_pws_and_pend(Pws::None);
                self.flow_write_scalar(s.as_str(), Self::flow_val_style(s));
            }
            container => self.visit_flow_container(container),
        }
    }

    fn visit_flow_sl(&mut self, node: &Node) {
        match node {
            Node::Seq(items, _) => {
                self.write("[");
                for (i, item) in items.iter().enumerate() {
                    self.write_pws_and_pend(Pws::None);
                    self.flow_value(item);
                    if i + 1 != items.len() {
                        self.write_pws_and_pend(Pws::None);
                        self.write(",");
                    }
                }
                self.write("]");
            }
            Node::Map(entries, _) => {
                self.write("{");
                for (i, (key, value)) in entries.iter().enumerate() {
                    self.flow_map_key(key);
                    self.flow_value(value);
                    if i + 1 != entries.len() {
                        self.write_pws_and_pend(Pws::None);
                        self.write(",");
                    }
                }
                self.write_pws_and_pend(Pws::None);
                self.write("}");
            }
            Node::Scalar(_) => unreachable!(),
        }
    }

    fn visit_flow_ml(&mut self, node: &Node) {
        let (open, close) = match node {
            Node::Seq(..) => ("[", "]"),
            _ => ("{", "}"),
        };
        self.write(open);
        self.pend(Pws::Newline);
        self.ilevel += 1;
        match node {
            Node::Seq(items, _) => {
                for (i, item) in items.iter().enumerate() {
                    self.write_pws_and_pend(Pws::None);
                    self.flow_value(item);
                    if i + 1 != items.len() {
                        self.write_pws_and_pend(Pws::None);
                        self.write(",");
                    }
                    self.pend(Pws::Newline);
                }
            }
            Node::Map(entries, _) => {
                for (i, (key, value)) in entries.iter().enumerate() {
                    self.flow_map_key(key);
                    self.flow_value(value);
                    if i + 1 != entries.len() {
                        self.write_pws_and_pend(Pws::None);
                        self.write(",");
                    }
                    self.pend(Pws::Newline);
                }
            }
            Node::Scalar(_) => unreachable!(),
        }
        self.ilevel -= 1;
        self.write_pws_and_pend(Pws::None);
        self.write(close);
    }

    fn flow_write_scalar(&mut self, s: &str, style: ScalarStyle) {
        match style {
            ScalarStyle::SingleQuoted => self.write_scalar_squo(s, self.ilevel),
            ScalarStyle::DoubleQuoted => self.write_scalar_dquo(s),
            _ => self.write_scalar_plain(s, self.ilevel),
        }
    }

    fn blck_write_scalar(&mut self, s: &str, style: ScalarStyle) {
        match style {
            ScalarStyle::Plain | ScalarStyle::Auto => self.write_scalar_plain(s, self.ilevel),
            ScalarStyle::SingleQuoted => self.write_scalar_squo(s, self.ilevel),
            ScalarStyle::DoubleQuoted => self.write_scalar_dquo(s),
            ScalarStyle::Literal => self.write_scalar_literal(s, self.ilevel),
            ScalarStyle::Folded => self.write_scalar_folded(s, self.ilevel),
        }
    }

    /// `_write_escaped_newlines`: one more newline than the run of newlines at `i`
    fn write_escaped_newlines(&mut self, s: &[u8], mut i: usize) -> usize {
        self.newl();
        loop {
            self.newl();
            i += 1;
            if !(i < s.len() && s[i] == b'\n') {
                break;
            }
        }
        i - 1
    }

    fn write_scalar_plain(&mut self, text: &str, mut ilevel: usize) {
        if ilevel == 0 && (text.starts_with("...") || text.starts_with("---")) {
            self.indent(ilevel + 1);
            ilevel += 1;
        }
        let s = text.as_bytes();
        let mut pos = 0;
        let mut i = 0;
        while i < s.len() {
            if s[i] == b'\n' {
                self.write(&text[pos..i]);
                i = self.write_escaped_newlines(s, i);
                pos = i + 1;
                if pos < s.len() {
                    self.indent(ilevel + 1);
                }
            }
            i += 1;
        }
        if pos < s.len() {
            self.write(&text[pos..]);
        }
    }

    fn write_scalar_squo(&mut self, text: &str, ilevel: usize) {
        let s = text.as_bytes();
        let mut pos = 0;
        self.write("'");
        let mut i = 0;
        while i < s.len() {
            if s[i] == b'\n' {
                self.write(&text[pos..i]);
                i = self.write_escaped_newlines(s, i);
                if i < s.len() {
                    self.indent(ilevel + 1);
                }
                pos = i + 1;
            } else if s[i] == b'\'' {
                self.write(&text[pos..=i]);
                self.write("'");
                pos = i + 1;
            }
            i += 1;
        }
        if pos < s.len() {
            self.write(&text[pos..]);
        }
        self.write("'");
    }

    fn write_scalar_dquo(&mut self, text: &str) {
        let s = text.as_bytes();
        let mut pos = 0;
        self.write("\"");
        for (i, &c) in s.iter().enumerate() {
            let escaped = match c {
                b'"' => "\\\"",
                b'\\' => "\\\\",
                b'\n' => "\\n",
                b'\r' => "\\r",
                0x08 => "\\b",
                _ => continue,
            };
            self.write(&text[pos..i]);
            self.write(escaped);
            pos = i + 1;
        }
        if pos < s.len() {
            self.write(&text[pos..]);
        }
        self.write("\"");
    }

    /// The chomping and indentation indicators of a block scalar
    fn block_header(&mut self, s: &str, indicator: &str, keep_first: bool) -> (usize, bool) {
        let trimmed_len = s.trim_end_matches('\n').len();
        let newlines_at_end = s.len() - trimmed_len;
        let newline_only = trimmed_len == 0 && !s.is_empty();
        let explicit_indentation = s.trim_start_matches(['\n', '\r']).starts_with([' ', '\t']);
        self.write(indicator);
        if explicit_indentation {
            self.write("2");
        }
        let keep = newlines_at_end > 1 || newline_only;
        let strip = newlines_at_end == 0;
        if keep_first {
            if keep {
                self.write("+");
            } else if strip {
                self.write("-");
            }
        } else if strip {
            self.write("-");
        } else if keep {
            self.write("+");
        }
        (newlines_at_end, newline_only)
    }

    fn write_scalar_literal(&mut self, text: &str, ilevel: usize) {
        let trimmed = text.trim_end_matches('\n');
        let (newlines_at_end, newline_only) = self.block_header(text, "|", true);
        if !trimmed.is_empty() {
            self.newl();
            let t = trimmed.as_bytes();
            let mut pos = 0;
            for i in 0..t.len() {
                if t[i] != b'\n' {
                    continue;
                }
                self.indent(ilevel + 1);
                self.write(&trimmed[pos..=i]);
                pos = i + 1;
            }
            if pos < t.len() {
                self.indent(ilevel + 1);
                self.write(&trimmed[pos..]);
            }
        }
        for _ in usize::from(!newline_only)..newlines_at_end {
            self.newl();
        }
    }

    fn write_scalar_folded(&mut self, text: &str, ilevel: usize) {
        let s = text.as_bytes();
        let trimmed = text.trim_end_matches('\n');
        let (newlines_at_end, newline_only) = self.block_header(text, ">", false);
        if !trimmed.is_empty() {
            self.newl();
            let mut pos = 0;
            let mut i = 0;
            while i < trimmed.len() {
                if s[i] != b'\n' {
                    i += 1;
                    continue;
                }
                if !is_indented_block(s, pos, i) {
                    if pos < i {
                        self.indent(ilevel + 1);
                        self.write(&text[pos..i]);
                        i = self.write_escaped_newlines(s, i);
                        pos = i + 1;
                    } else if i + 1 < s.len() {
                        if s[i + 1] == b'\n' {
                            i += 1;
                            i = self.write_escaped_newlines(s, i);
                            pos = i + 1;
                        } else {
                            self.newl();
                            pos = i + 1;
                        }
                    }
                } else {
                    i += 1;
                    self.indent(ilevel + 1);
                    self.write(&text[pos..i]);
                    if pos > 0 || !text.starts_with([' ', '\t']) {
                        i = self.write_indented_block(text, i, ilevel);
                    }
                    pos = i;
                    // The loop increment of the C++ code
                    i += 1;
                    continue;
                }
                i += 1;
            }
            if pos < trimmed.len() {
                self.indent(ilevel + 1);
                self.write(&trimmed[pos..]);
            }
        }
        for _ in usize::from(!newline_only)..newlines_at_end {
            self.newl();
        }
    }

    fn write_indented_block(&mut self, text: &str, mut i: usize, ilevel: usize) -> usize {
        loop {
            let found = text[i..].find("\n ").or_else(|| text[i..].find("\n\t")).map(|p| p + i);
            match found {
                Some(pos) => {
                    let pos = pos + 1;
                    self.indent(ilevel + 1);
                    self.write(&text[i..pos]);
                    i = pos;
                }
                None => break,
            }
        }
        if let Some(pos) = text[i..].find('\n').map(|p| p + i) {
            let end = text[pos..].find(|c| c != '\n').map(|p| p + pos).unwrap_or(pos);
            self.indent(ilevel + 1);
            self.write(&text[i..end]);
            i = end;
        }
        i
    }
}

/// `_is_indented_block`
fn is_indented_block(s: &[u8], prev: usize, i: usize) -> bool {
    if prev == 0 && s.first().is_some_and(|&c| c == b' ' || c == b'\t') {
        return true;
    }
    match s[i..].iter().position(|&c| c != b'\n') {
        Some(p) => s[i + p] == b' ' || s[i + p] == b'\t',
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_numbers_like_c4() {
        for n in ["0", "-1", "+2", "1.5", ".5", "1.", "1e5", "-1.5e-3", "0x1f", "0b101", "0o17", "inf", "-nan"] {
            assert!(is_number(n), "{n}");
        }
        for n in ["", "-", "1a", "1 2", "e5", ".", "1e", "0x", "abc", "1:2"] {
            assert!(!is_number(n), "{n}");
        }
    }

    #[test]
    fn chooses_like_rapidyaml() {
        assert_eq!(scalar_style_choose(Some("a")), ScalarStyle::Plain);
        assert_eq!(scalar_style_choose(Some("-1")), ScalarStyle::Plain);
        assert_eq!(scalar_style_choose(Some("-a")), ScalarStyle::SingleQuoted);
        assert_eq!(scalar_style_choose(Some("a: b")), ScalarStyle::SingleQuoted);
        assert_eq!(scalar_style_choose(Some("a\n b")), ScalarStyle::DoubleQuoted);
        assert_eq!(scalar_style_choose(Some("a ")), ScalarStyle::DoubleQuoted);
        assert_eq!(scalar_style_choose(Some("")), ScalarStyle::SingleQuoted);
        assert_eq!(scalar_style_choose(None), ScalarStyle::Plain);
    }

    #[test]
    fn writes_block_literals() {
        let mut e = Emitter::new();
        e.write_scalar_literal("a\n\nb\n\n", 1);
        // Empty lines are indented too, the snapshotter strips trailing spaces afterwards
        assert_eq!(e.out, "|+\n    a\n    \n    b\n");
        let mut e = Emitter::new();
        e.write_scalar_literal(" a", 0);
        assert_eq!(e.out, "|2-\n   a");
    }
}
