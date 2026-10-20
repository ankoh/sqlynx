//! Utilities shared by the modules of the core.

pub mod rope;
pub mod sort;
pub mod topk;

/// ASCII lower-casing of the C++ `TOLOWER_ASCII_TABLE`
#[inline]
pub fn tolower_fuzzy(c: u8) -> u8 {
    c.to_ascii_lowercase()
}

/// Compare two byte strings case-insensitively (`fuzzy_ci_string_view::compare`)
pub fn ci_cmp(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    for (x, y) in a.iter().zip(b) {
        match tolower_fuzzy(*x).cmp(&tolower_fuzzy(*y)) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    a.len().cmp(&b.len())
}

/// Does `text` start with `prefix`, ignoring ASCII case?
pub fn ci_starts_with(text: &[u8], prefix: &[u8]) -> bool {
    text.len() >= prefix.len() && text.iter().zip(prefix).all(|(a, b)| tolower_fuzzy(*a) == tolower_fuzzy(*b))
}

/// Find `needle` in `haystack`, ignoring ASCII case (`fuzzy_ci_string_view::find`)
pub fn ci_find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&i| ci_starts_with(&haystack[i..], needle))
}

/// Quote an identifier if it would not round-trip unquoted (`quote_anyupper_fuzzy`)
pub fn quote_identifier(text: &str) -> String {
    let is_start = |c: u8| c.is_ascii_alphabetic() || c == b'_' || c >= 0x80;
    let is_cont = |c: u8| is_start(c) || c.is_ascii_digit() || c == b'$';
    let bytes = text.as_bytes();
    let requires_quotes = bytes.is_empty()
        || bytes.iter().any(|c| c.is_ascii_uppercase())
        || !is_start(bytes[0])
        || !bytes.iter().all(|&c| is_cont(c));
    if !requires_quotes {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        if c == '"' {
            out.push('"');
        }
        out.push(c);
    }
    out.push('"');
    out
}
