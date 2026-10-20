//! `rapidjson::PrettyWriter<StringBuffer>` of rapidjson 1.1.0 with the default flags, as the Vega-Lite generator
//! uses it (`SetIndent(' ', 2)`).

use crate::view::json::{write_double, write_string};

/// A nesting level (`Writer::Level`)
struct Level {
    in_array: bool,
    value_count: usize,
}

/// A port of `PrettyWriter<StringBuffer>` with an indentation of two spaces
pub(crate) struct PrettyWriter {
    out: Vec<u8>,
    levels: Vec<Level>,
}

impl PrettyWriter {
    pub fn new() -> Self {
        Self { out: Vec::with_capacity(256), levels: Vec::new() }
    }

    /// The written text
    pub fn finish(self) -> Vec<u8> {
        self.out
    }

    fn write_indent(&mut self) {
        let count = self.levels.len() * 2;
        self.out.resize(self.out.len() + count, b' ');
    }

    /// `PrettyPrefix`
    fn prefix(&mut self) {
        let Some(level) = self.levels.last_mut() else {
            return;
        };
        let in_array = level.in_array;
        let value_count = level.value_count;
        level.value_count += 1;
        if in_array {
            if value_count > 0 {
                self.out.push(b','); // add comma if it is not the first element in array
            }
            self.out.push(b'\n');
            self.write_indent();
        } else {
            // in object
            if value_count > 0 {
                if value_count % 2 == 0 {
                    self.out.extend_from_slice(b",\n");
                } else {
                    self.out.extend_from_slice(b": ");
                }
            } else {
                self.out.push(b'\n');
            }
            if value_count % 2 == 0 {
                self.write_indent();
            }
        }
    }

    /// `Key(str, length)`
    pub fn key(&mut self, s: &[u8]) {
        self.string(s);
    }

    /// `String(str, length)`
    pub fn string(&mut self, s: &[u8]) {
        self.prefix();
        write_string(&mut self.out, s);
    }

    pub fn bool(&mut self, b: bool) {
        self.prefix();
        self.out.extend_from_slice(if b { b"true" } else { b"false" });
    }

    pub fn int(&mut self, i: i32) {
        self.prefix();
        self.out.extend_from_slice(i.to_string().as_bytes());
    }

    pub fn int64(&mut self, i: i64) {
        self.prefix();
        self.out.extend_from_slice(i.to_string().as_bytes());
    }

    /// A double with the shortest round-trip digits, `null` for NaN and infinity
    pub fn double(&mut self, d: f64) {
        self.prefix();
        write_double(&mut self.out, d);
    }

    pub fn start_object(&mut self) {
        self.prefix();
        self.levels.push(Level { in_array: false, value_count: 0 });
        self.out.push(b'{');
    }

    pub fn end_object(&mut self) {
        let level = self.levels.pop().expect("unbalanced object");
        if level.value_count != 0 {
            self.out.push(b'\n');
            self.write_indent();
        }
        self.out.push(b'}');
    }

    pub fn start_array(&mut self) {
        self.prefix();
        self.levels.push(Level { in_array: true, value_count: 0 });
        self.out.push(b'[');
    }

    pub fn end_array(&mut self) {
        let level = self.levels.pop().expect("unbalanced array");
        if level.value_count != 0 {
            self.out.push(b'\n');
            self.write_indent();
        }
        self.out.push(b']');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_pretty_json() {
        let mut w = PrettyWriter::new();
        w.start_object();
        w.key(b"a");
        w.start_array();
        w.int(1);
        w.double(2.0);
        w.double(f64::NAN);
        w.end_array();
        w.key(b"b");
        w.start_object();
        w.end_object();
        w.key(b"c");
        w.start_array();
        w.end_array();
        w.key(b"d\0");
        w.bool(false);
        w.end_object();
        assert_eq!(
            String::from_utf8(w.finish()).unwrap(),
            "{\n  \"a\": [\n    1,\n    2.0,\n    null\n  ],\n  \"b\": {},\n  \"c\": [],\n  \"d\\u0000\": false\n}"
        );
    }
}
