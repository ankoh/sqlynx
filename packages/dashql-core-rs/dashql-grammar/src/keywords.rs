//! The keywords of the grammar, generated from `grammar/lists/*.list` (shared with the C++ scanner).

use crate::{symbol_kind, SymbolKind};

#[rustfmt::skip]
mod table;

pub use table::{KEYWORDS, MAX_KEYWORD_LENGTH};

/// The category of a keyword
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeywordCategory {
    SqlColumnName,
    SqlReserved,
    SqlTypeFunc,
    SqlUnreserved,
    VisUnreserved,
}

/// A keyword
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Keyword {
    /// The lower-case keyword text
    pub name: &'static str,
    /// The terminal symbol of the keyword
    pub symbol: SymbolKind,
    /// The category
    pub category: KeywordCategory,
}

impl Keyword {
    /// Find a keyword by its lower-case text
    pub fn find(text: &[u8]) -> Option<&'static Keyword> {
        if text.len() > MAX_KEYWORD_LENGTH {
            return None;
        }
        KEYWORDS
            .binary_search_by(|k| k.name.as_bytes().cmp(text))
            .ok()
            .map(|i| &KEYWORDS[i])
    }

    /// The keyword text of a terminal symbol, if the symbol is a keyword
    pub fn name_of(symbol: SymbolKind) -> Option<&'static str> {
        if symbol == symbol_kind::S_VISUALIZE_LA {
            return Some("visualize");
        }
        keyword_names()[symbol as usize]
    }
}

/// Keyword texts indexed by symbol kind
fn keyword_names() -> &'static [Option<&'static str>] {
    static NAMES: std::sync::OnceLock<Vec<Option<&'static str>>> = std::sync::OnceLock::new();
    NAMES.get_or_init(|| {
        let mut names = vec![None; crate::tables::YYNTOKENS];
        for k in KEYWORDS {
            names[k.symbol as usize] = Some(k.name);
        }
        names
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_keywords() {
        assert_eq!(KEYWORDS.len(), 586);
        let select = Keyword::find(b"select").unwrap();
        assert_eq!(select.symbol, symbol_kind::S_SELECT);
        assert_eq!(select.category, KeywordCategory::SqlReserved);
        assert_eq!(Keyword::find(b"SELECT"), None);
        assert_eq!(Keyword::find(b"selec"), None);
        assert_eq!(Keyword::find(b"a_name_that_is_too_long_to_be_a_keyword"), None);
        assert!(KEYWORDS.windows(2).all(|w| w[0].name < w[1].name));
    }

    #[test]
    fn names_symbols() {
        assert_eq!(Keyword::name_of(symbol_kind::S_SELECT), Some("select"));
        assert_eq!(Keyword::name_of(symbol_kind::S_VISUALIZE_LA), Some("visualize"));
        assert_eq!(Keyword::name_of(symbol_kind::S_IDENT), None);
        assert_eq!(Keyword::name_of(symbol_kind::S_NOT_LA), None);
    }
}
