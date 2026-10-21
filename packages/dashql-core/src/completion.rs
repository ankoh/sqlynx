//! Completion, a port of `src/analyzer/completion.cc`.
//!
//! Completion collects candidates from the expected grammar symbols at the cursor (probed through
//! the LR automaton), the name search indexes of the script and the catalog, and the name scopes
//! around the cursor. Candidates are scored by tags and the top k are selected by score, ties are ranked
//! by name.

// Bison names some symbol kinds in mixed case (S_Op)
#![allow(non_upper_case_globals)]

use crate::analyzer::{AnalyzedScript, ColumnResolution, ReferencedTable, ScopeId, ScopeSource, SourceVisibility, TableRole};
use crate::catalog::*;
use crate::cursor::{CursorContext, NameComponentType, ScriptCursor, SymbolLocation};
use crate::hash::HashMap;
use crate::utils::topk::TopKHeap;
use crate::utils::{ci_cmp, ci_find, ci_starts_with};
use dashql_buffers::analyzer::NameTag;
use dashql_buffers::completion::{CandidateTag, CompletionStrategy};
use dashql_buffers::cursor::RelativeSymbolPosition;
use dashql_buffers::parser::{AttributeKey, NodeType, SymbolSpan};
use dashql_parser::keywords::Keyword;
use dashql_parser::parser::context::resolve_text_span;
use dashql_parser::parser::probe::{self, PrefixSnapshot};
use dashql_parser::scanner::Symbol;
use dashql_parser::symbol_kind::*;
use dashql_parser::SymbolKind;
use std::cmp::Ordering;
use std::sync::Arc;

/// A score value
pub type Score = u32;

// Keyword prevalence modifiers: "se" should suggest "select" before "set"
const KEYWORD_A: Score = 4;
const KEYWORD_B: Score = 3;
const KEYWORD_C: Score = 2;
const KEYWORD_D: Score = 0;

// Coarse base score of a registered name
const NAME_TAG_IGNORE: Score = 0;
const NAME_TAG_UNLIKELY: Score = 10;
const NAME_TAG_LIKELY: Score = 20;

// Fine-granular score modifiers
const SUBSTRING_SCORE_MODIFIER: Score = 30;
const PREFIX_SCORE_MODIFIER: Score = 5;
const EXACT_MATCH_SCORE_MODIFIER: Score = 15;
const KEYWORD_SUBSTRING_BONUS: Score = 20;
const THROUGH_CATALOG_SCORE_MODIFIER: Score = 2;
const RESOLVING_TABLE_SCORE_MODIFIER: Score = 5;
const UNRESOLVED_PEER_SCORE_MODIFIER: Score = 1;
const DOT_SCHEMA_SCORE_MODIFIER: Score = 2;
const DOT_TABLE_SCORE_MODIFIER: Score = 2;
const DOT_COLUMN_SCORE_MODIFIER: Score = 2;
const IN_NAME_SCOPE_SCORE_MODIFIER: Score = 10;
const IN_SAME_STATEMENT_SCORE_MODIFIER: Score = 1;

// Suffix-probe modifiers
const SUFFIX_INCOMPATIBLE_PENALTY: Score = 15;
const SUFFIX_DEPTH_ONE_BONUS: Score = 0;
const SUFFIX_DEPTH_MANY_BONUS: Score = 1;

// Identity candidate scores
const IDENTITY_SCORE_TABLE_REF: Score = 50;
const IDENTITY_SCORE_TABLE_REF_ALIAS: Score = 50;
const IDENTITY_SCORE_COLUMN_REF: Score = 59;

/// Longer identity candidates are dropped (e.g. an unterminated delimited identifier)
const MAX_IDENTITY_LENGTH: usize = 64;

/// The candidate tags, a bitset of `CandidateTag`
pub type CandidateTags = u32;

fn has(tags: CandidateTags, tag: CandidateTag) -> bool {
    tags & tag.0 != 0
}

/// `computeCandidateScore`
fn compute_candidate_score(tags: CandidateTags) -> Score {
    let mut score: Score = 0;
    let add = |score: &mut Score, tag: CandidateTag, value: Score| {
        if has(tags, tag) {
            *score += value;
        }
    };
    add(&mut score, CandidateTag::KEYWORD_D, KEYWORD_D);
    add(&mut score, CandidateTag::KEYWORD_C, KEYWORD_C);
    add(&mut score, CandidateTag::KEYWORD_B, KEYWORD_B);
    add(&mut score, CandidateTag::KEYWORD_A, KEYWORD_A);
    add(&mut score, CandidateTag::SUBSTRING_MATCH, SUBSTRING_SCORE_MODIFIER);
    add(&mut score, CandidateTag::PREFIX_MATCH, PREFIX_SCORE_MODIFIER);
    add(&mut score, CandidateTag::EXACT_MATCH, EXACT_MATCH_SCORE_MODIFIER);
    if has(tags, CandidateTag::EXPECTED_PARSER_SYMBOL) && has(tags, CandidateTag::SUBSTRING_MATCH) {
        score += KEYWORD_SUBSTRING_BONUS;
    }
    add(&mut score, CandidateTag::THROUGH_CATALOG, THROUGH_CATALOG_SCORE_MODIFIER);
    add(&mut score, CandidateTag::RESOLVING_TABLE, RESOLVING_TABLE_SCORE_MODIFIER);
    add(&mut score, CandidateTag::UNRESOLVED_PEER, UNRESOLVED_PEER_SCORE_MODIFIER);
    add(&mut score, CandidateTag::DOT_RESOLUTION_TABLE, DOT_TABLE_SCORE_MODIFIER);
    add(&mut score, CandidateTag::DOT_RESOLUTION_SCHEMA, DOT_SCHEMA_SCORE_MODIFIER);
    add(&mut score, CandidateTag::DOT_RESOLUTION_COLUMN, DOT_COLUMN_SCORE_MODIFIER);
    add(&mut score, CandidateTag::IN_NAME_SCOPE, IN_NAME_SCOPE_SCORE_MODIFIER);
    add(&mut score, CandidateTag::IN_SAME_STATEMENT, IN_SAME_STATEMENT_SCORE_MODIFIER);
    add(&mut score, CandidateTag::SUFFIX_DEPTH_ONE, SUFFIX_DEPTH_ONE_BONUS);
    add(&mut score, CandidateTag::SUFFIX_DEPTH_MANY, SUFFIX_DEPTH_MANY_BONUS);
    let penalty = if has(tags, CandidateTag::SUFFIX_INCOMPATIBLE) { SUFFIX_INCOMPATIBLE_PENALTY } else { 0 };
    score.saturating_sub(penalty)
}

/// The base scores of the name tags per strategy (`NameScoringTable`)
fn name_tag_scores(strategy: CompletionStrategy) -> [(NameTag, Score); 7] {
    match strategy {
        CompletionStrategy::TABLE_REF => [
            (NameTag::NONE, NAME_TAG_IGNORE),
            (NameTag::SCHEMA_NAME, NAME_TAG_LIKELY),
            (NameTag::DATABASE_NAME, NAME_TAG_LIKELY),
            (NameTag::TABLE_NAME, NAME_TAG_LIKELY),
            (NameTag::TABLE_ALIAS, NAME_TAG_UNLIKELY),
            (NameTag::COLUMN_NAME, NAME_TAG_UNLIKELY),
            (NameTag::FUNCTION_NAME, NAME_TAG_UNLIKELY),
        ],
        CompletionStrategy::COLUMN_REF => [
            (NameTag::NONE, NAME_TAG_IGNORE),
            (NameTag::SCHEMA_NAME, NAME_TAG_UNLIKELY),
            (NameTag::DATABASE_NAME, NAME_TAG_UNLIKELY),
            (NameTag::TABLE_NAME, NAME_TAG_UNLIKELY),
            (NameTag::TABLE_ALIAS, NAME_TAG_LIKELY),
            (NameTag::COLUMN_NAME, NAME_TAG_LIKELY),
            (NameTag::FUNCTION_NAME, NAME_TAG_UNLIKELY),
        ],
        _ => [
            (NameTag::NONE, NAME_TAG_IGNORE),
            (NameTag::SCHEMA_NAME, NAME_TAG_LIKELY),
            (NameTag::DATABASE_NAME, NAME_TAG_LIKELY),
            (NameTag::TABLE_NAME, NAME_TAG_LIKELY),
            (NameTag::TABLE_ALIAS, NAME_TAG_LIKELY),
            (NameTag::COLUMN_NAME, NAME_TAG_LIKELY),
            (NameTag::FUNCTION_NAME, NAME_TAG_LIKELY),
        ],
    }
}

/// The prevalence of a keyword (`GetKeywordPrevalence`)
fn keyword_prevalence(keyword: SymbolKind) -> CandidateTag {
    match keyword {
        S_SELECT | S_FROM | S_WHERE => CandidateTag::KEYWORD_A,
        S_AND | S_GROUP_P | S_ORDER => CandidateTag::KEYWORD_B,
        S_AS | S_ASC_P | S_BY | S_CASE | S_CAST | S_DESC_P | S_END_P | S_LIKE | S_LIMIT | S_OFFSET | S_OR | S_SET
        | S_THEN | S_WHEN | S_WITH => CandidateTag::KEYWORD_C,
        _ => CandidateTag::KEYWORD_D,
    }
}

/// Tokens after which no passive keyword hints are shown (`suppressPassiveHint`)
fn suppress_passive_hint(kind: SymbolKind) -> bool {
    matches!(kind, S_SELECT | S_FROM | S_JOIN | S_WHERE | S_ON | S_AND | S_OR | S_BY | S_VISUALISE | S_VISUALIZE)
}

/// The continuation score of a keyword (`getKeywordContinuationScore`)
fn keyword_continuation_score(kind: SymbolKind) -> u8 {
    match kind {
        S_BY | S_AS | S_EQUALS_GREATER | S_ON | S_SELECT | S_INTO | S_TABLE | S_SET => 10,
        S_OUTER_P | S_ASC_P | S_DESC_P | S_NULLS_P | S_FIRST_P | S_LAST_P | S_UNBOUNDED | S_PRECEDING | S_CURRENT_P
        | S_ROW | S_WITHIN | S_SETS => 6,
        _ => 0,
    }
}

/// Is a scanner symbol kind completable? (`Completion::IsSymbolKindCompletable`)
pub fn is_symbol_kind_completable(kind: SymbolKind) -> bool {
    !matches!(
        kind,
        S_SCONST
            | S_ICONST
            | S_FCONST
            | S_BCONST
            | S_XCONST
            | S_COMMA
            | S_LRB
            | S_RRB
            | S_LSB
            | S_RSB
            | S_SEMICOLON
            | S_COLON
            | S_PLUS
            | S_MINUS
            | S_STAR
            | S_DIVIDE
            | S_MODULO
            | S_QUESTION_MARK
            | S_PARAM
            | S_CIRCUMFLEX
            | S_LESS_THAN
            | S_GREATER_THAN
            | S_EQUALS
            | S_Op
            | S_EQUALS_GREATER
            | S_LESS_EQUALS
            | S_GREATER_EQUALS
            | S_NOT_EQUALS
            | S_DOT_STAR_LA
    )
}

/// The catalog object of a candidate
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateObjectRef {
    /// A database, by its catalog id (script reference or catalog declaration)
    Database(QualifiedCatalogObjectId),
    /// A schema, by its catalog id
    Schema(QualifiedCatalogObjectId),
    Table(TableLoc),
    Column(ColumnLoc),
    Function(ObjectLoc),
}

impl CandidateObjectRef {
    pub fn object_type(&self) -> CatalogObjectType {
        match self {
            CandidateObjectRef::Database(_) => CatalogObjectType::DatabaseReference,
            CandidateObjectRef::Schema(_) => CatalogObjectType::SchemaReference,
            CandidateObjectRef::Table(_) => CatalogObjectType::TableDeclaration,
            CandidateObjectRef::Column(_) => CatalogObjectType::ColumnDeclaration,
            CandidateObjectRef::Function(_) => CatalogObjectType::FunctionDeclaration,
        }
    }
}

/// A catalog object of a candidate (`CandidateCatalogObject`)
#[derive(Clone, Debug)]
pub struct CandidateObject {
    /// The candidate (index into the candidate buffer)
    pub candidate: usize,
    /// The candidate tags of the object
    pub candidate_tags: CandidateTags,
    /// The qualified id of the catalog object
    pub catalog_object_id: QualifiedCatalogObjectId,
    /// The catalog object
    pub object: CandidateObjectRef,
    /// The score, computed from the candidate tags
    pub score: Score,
    /// The qualified name
    pub qualified_name: Vec<Arc<str>>,
    /// The index of the target name in the qualified name
    pub qualified_name_target_idx: usize,
    /// Whether to prefer the qualified name, set for ambiguous names and aliased tables
    pub prefer_qualified: bool,
}

/// A completion candidate (`Completion::Candidate`)
#[derive(Clone, Debug)]
pub struct Candidate {
    /// The text to insert
    pub completion_text: Arc<str>,
    /// Identity candidates are emitted as typed, without quoting
    pub completion_text_is_verbatim: bool,
    /// The combined analyzer tags of the name
    pub coarse_name_tags: u8,
    /// The combined candidate tags
    pub candidate_tags: CandidateTags,
    /// The text range to replace
    pub target_location: SymbolSpan,
    /// The text range to replace with a qualified name
    pub target_location_qualified: SymbolSpan,
    /// The catalog objects (indices into the candidate objects)
    pub catalog_objects: Vec<usize>,
    /// The score, higher is better
    pub score: Score,
    /// The keyword symbol of keyword candidates
    pub keyword_symbol: Option<SymbolKind>,
    /// The keyword continuation (e.g. "by")
    pub keyword_continuation: Option<&'static str>,
}

impl Candidate {
    fn new(
        completion_text: Arc<str>,
        name_tags: u8,
        tags: CandidateTags,
        location: SymbolSpan,
        qualified: SymbolSpan,
    ) -> Self {
        Self {
            completion_text,
            completion_text_is_verbatim: false,
            coarse_name_tags: name_tags,
            candidate_tags: tags,
            target_location: location,
            target_location_qualified: qualified,
            catalog_objects: Vec::new(),
            score: 0,
            keyword_symbol: None,
            keyword_continuation: None,
        }
    }
}

/// The rank of candidates, greater is better: higher scores, then smaller names in case-insensitive order, then in
/// byte order. Names are unique among the candidates of the name indexes, but a keyword or the identity candidate
/// may spell the same; keywords rank before names, the rest by their tags.
fn candidate_cmp(l: &Candidate, r: &Candidate) -> Ordering {
    l.score
        .cmp(&r.score)
        .then_with(|| ci_cmp(r.completion_text.as_bytes(), l.completion_text.as_bytes()))
        .then_with(|| r.completion_text.cmp(&l.completion_text))
        .then_with(|| l.keyword_symbol.is_some().cmp(&r.keyword_symbol.is_some()))
        .then_with(|| r.keyword_symbol.cmp(&l.keyword_symbol))
        .then_with(|| r.candidate_tags.cmp(&l.candidate_tags))
}

type CandidateHeap = TopKHeap<Candidate, fn(&Candidate, &Candidate) -> Ordering>;

/// A completion at a cursor
pub struct Completion<'c, 'a> {
    /// The cursor to complete at
    pub cursor: &'c ScriptCursor<'a>,
    /// The completion strategy, derived from the cursor context
    pub strategy: CompletionStrategy,
    /// Is the target qualified?
    pub dot_completion: bool,
    /// Is the cursor at a name definition?
    pub at_definition: bool,
    /// Is the cursor between symbols?
    pub between_symbols: bool,
    /// Is there a real token after the cursor?
    pub has_post_cursor_token: bool,
    /// The symbol being completed
    pub target_symbol: Option<SymbolLocation>,
    /// The collected candidates, one per name
    pub candidates: Vec<Candidate>,
    /// The catalog objects of the candidates
    pub candidate_objects: Vec<CandidateObject>,
    /// The candidate indexes by completion text
    candidates_by_name: HashMap<Arc<str>, usize>,
    /// The candidate object indexes by catalog object id
    candidate_objects_by_id: HashMap<QualifiedCatalogObjectId, usize>,
    /// The heap that selects the top candidates
    candidate_heap: CandidateHeap,
    /// The selected candidates, best first
    pub top_candidates: Vec<Candidate>,
}

/// A dot candidate
struct DotCandidate {
    /// The name to complete
    name: Arc<str>,
    /// The candidate tags
    candidate_tags: CandidateTags,
    /// The analyzer tags of the name
    name_tags: u8,
    /// The qualified id of the catalog object
    object_id: QualifiedCatalogObjectId,
    /// The catalog object the name refers to
    object: CandidateObjectRef,
}

/// Trim double quotes at both ends
fn trim_double_quotes(s: &[u8]) -> &[u8] {
    let begin = s.iter().position(|&c| c != b'"').unwrap_or(s.len());
    let end = s.iter().rposition(|&c| c != b'"').map(|e| e + 1).unwrap_or(begin).max(begin);
    &s[begin..end]
}

/// Lossless text of bytes that came from the script text at char boundaries
fn text_arc(bytes: &[u8]) -> Arc<str> {
    Arc::from(String::from_utf8_lossy(bytes).as_ref())
}

/// The match tags of a name against a prefix, None if the prefix is not a substring
fn match_tags(name: &[u8], prefix: &[u8]) -> Option<CandidateTags> {
    let pos = ci_find(name, prefix)?;
    let mut tags = CandidateTag::SUBSTRING_MATCH.0;
    if pos == 0 {
        tags |= CandidateTag::PREFIX_MATCH.0;
        if name.len() == prefix.len() {
            tags |= CandidateTag::EXACT_MATCH.0;
        }
    }
    Some(tags)
}

impl<'c, 'a> Completion<'c, 'a> {
    fn new(cursor: &'c ScriptCursor<'a>, k: usize) -> Self {
        let strategy = match cursor.context {
            CursorContext::TableRef { at_alias: true, .. } => CompletionStrategy::TABLE_REF_ALIAS,
            CursorContext::TableRef { .. } => CompletionStrategy::TABLE_REF,
            CursorContext::ColumnRef { .. } => CompletionStrategy::COLUMN_REF,
            CursorContext::None => CompletionStrategy::DEFAULT,
        };
        Self {
            cursor,
            strategy,
            dot_completion: false,
            at_definition: false,
            between_symbols: false,
            has_post_cursor_token: false,
            target_symbol: None,
            candidates: Vec::new(),
            candidate_objects: Vec::new(),
            candidates_by_name: HashMap::default(),
            candidate_objects_by_id: HashMap::default(),
            candidate_heap: TopKHeap::new(k, candidate_cmp as fn(&Candidate, &Candidate) -> Ordering),
            top_candidates: Vec::new(),
        }
    }

    fn symbols(&self) -> &'a [Symbol] {
        &self.cursor.script.scanned.unwrap().symbols
    }

    fn text(&self) -> &'a str {
        &self.cursor.script.scanned.unwrap().text
    }

    fn analyzed(&self) -> Option<&'a Arc<AnalyzedScript>> {
        self.cursor.script.analyzed
    }

    fn catalog(&self) -> &'a Catalog {
        self.cursor.script.catalog
    }

    /// The text at a text range, clamped to the script text
    fn text_at(&self, offset: u32, length: u32) -> &'a [u8] {
        let text = self.text().as_bytes();
        let begin = (offset as usize).min(text.len());
        let end = (begin + length as usize).min(text.len());
        &text[begin..end]
    }

    /// The location of a symbol as a text-based SymbolSpan
    fn symbol_location(symbol: &Symbol) -> SymbolSpan {
        SymbolSpan::new(symbol.location.offset, symbol.location.length)
    }

    /// The data of a catalog entry: the analyzed script itself or a catalog entry
    pub fn entry_data(&self, entry: CatalogEntryId) -> Option<&'a CatalogEntryData> {
        if let Some(analyzed) = self.analyzed() {
            if analyzed.entry.catalog_entry_id == entry {
                return Some(&analyzed.entry);
            }
        }
        self.catalog().entry(entry).map(|e| e.data())
    }

    pub fn table(&self, loc: TableLoc) -> Option<&'a TableDeclaration> {
        self.entry_data(loc.entry)?.table_declarations.get(loc.index as usize)
    }

    fn is_at_eof(&self, id: u32) -> bool {
        id as usize >= self.symbols().len()
    }

    fn next_symbol(&self, id: u32) -> u32 {
        (id + 1).min(self.symbols().len() as u32 - 1)
    }

    /// The id and data of a name index object
    fn index_object(&self, object: CatalogObjectRef) -> Option<(QualifiedCatalogObjectId, CandidateObjectRef)> {
        let data = self.entry_data(object.entry())?;
        let id = data.object_id(object);
        let candidate_object = match object {
            CatalogObjectRef::Database(_) => CandidateObjectRef::Database(id),
            CatalogObjectRef::Schema(_) => CandidateObjectRef::Schema(id),
            CatalogObjectRef::Table(t) => CandidateObjectRef::Table(t),
            CatalogObjectRef::Column(c) => CandidateObjectRef::Column(c),
            CatalogObjectRef::Function(f) => CandidateObjectRef::Function(f),
        };
        Some((id, candidate_object))
    }

    /// Add a catalog object to a candidate
    fn add_object(
        &mut self,
        candidate: usize,
        tags: CandidateTags,
        object_id: QualifiedCatalogObjectId,
        object: CandidateObjectRef,
    ) {
        let co = self.candidate_objects.len();
        self.candidate_objects.push(CandidateObject {
            candidate,
            candidate_tags: tags,
            catalog_object_id: object_id,
            object,
            score: 0,
            qualified_name: Vec::new(),
            qualified_name_target_idx: 0,
            prefer_qualified: false,
        });
        self.candidates[candidate].catalog_objects.push(co);
        self.candidate_objects_by_id.insert(object_id, co);
    }

    /// Compute the completion at a cursor (`Completion::Compute`)
    pub fn compute(cursor: &'c ScriptCursor<'a>, k: usize) -> Self {
        let mut completion = Completion::new(cursor, k);
        let Some(location) = cursor.scanner_location else { return completion };
        let scanned = cursor.script.scanned.unwrap();
        // Don't complete inside comments
        if crate::cursor::is_inside_comment(scanned, cursor.text_offset) {
            return completion;
        }
        completion.target_symbol = Some(location.current);
        let mut previous_symbol = location.previous;

        // Between symbols, or at the very beginning
        if location.current.relative_pos == RelativeSymbolPosition::AFTER_SYMBOL
            || (location.current.relative_pos == RelativeSymbolPosition::BEFORE_SYMBOL && previous_symbol.is_none())
        {
            completion.between_symbols = true;
        }
        let between_symbols = completion.between_symbols;

        let use_previous_if_at_end =
            |completion: &mut Completion, previous: &mut Option<SymbolLocation>| match *previous {
                Some(p) if p.relative_pos == RelativeSymbolPosition::END_OF_SYMBOL => {
                    completion.target_symbol = Some(p);
                    *previous = None;
                    true
                }
                _ => false,
            };

        let target = completion.target_symbol.unwrap();
        if !between_symbols && target.is_dot() {
            match target.relative_pos {
                RelativeSymbolPosition::AFTER_SYMBOL | RelativeSymbolPosition::END_OF_SYMBOL => {
                    completion.dot_completion = true
                }
                // Don't complete the dot itself. The C++ switch falls through to the return.
                _ => {
                    if target.relative_pos == RelativeSymbolPosition::BEGIN_OF_SYMBOL {
                        use_previous_if_at_end(&mut completion, &mut previous_symbol);
                    }
                    return completion;
                }
            }
        } else if !between_symbols && target.is_trailing_dot() {
            match target.relative_pos {
                RelativeSymbolPosition::AFTER_SYMBOL | RelativeSymbolPosition::END_OF_SYMBOL => {
                    completion.dot_completion = true
                }
                RelativeSymbolPosition::BEGIN_OF_SYMBOL => {
                    if !use_previous_if_at_end(&mut completion, &mut previous_symbol) {
                        return completion;
                    }
                }
                _ => return completion,
            }
        }

        // Skip completion for the current symbol, e.g. at a comma
        if !between_symbols && !is_symbol_kind_completable(completion.target_symbol.unwrap().symbol.kind) {
            if !use_previous_if_at_end(&mut completion, &mut previous_symbol) {
                return completion;
            }
            if !is_symbol_kind_completable(completion.target_symbol.unwrap().symbol.kind) {
                return completion;
            }
        }
        let target = completion.target_symbol.unwrap();

        // Find the expected symbols when not dot-completing, keep the snapshot for the suffix probes
        let mut expects_identifier = false;
        let mut expected_at_cursor = probe::ExpectedAtCursor::default();
        if !completion.dot_completion {
            let parse_until = if target.relative_pos == RelativeSymbolPosition::AFTER_SYMBOL
                && !completion.is_at_eof(target.symbol_id)
            {
                completion.next_symbol(target.symbol_id)
            } else {
                target.symbol_id
            };
            expected_at_cursor = probe::parse_until_with_snapshot(completion.symbols(), parse_until);
            expects_identifier = expected_at_cursor.expected.contains(&S_IDENT);
        }

        // Is the cursor at a definition position?
        if let Some(parsed) = cursor.script.parsed {
            for &node_id in &cursor.ast_path_to_root {
                if matches!(
                    parsed.nodes[node_id as usize].attribute_key(),
                    AttributeKey::SQL_CREATE_TABLE_NAME
                        | AttributeKey::SQL_CREATE_AS_NAME
                        | AttributeKey::SQL_VIEW_NAME
                        | AttributeKey::SQL_COLUMN_DEF_NAME
                        | AttributeKey::SQL_RESULT_TARGET_NAME
                        | AttributeKey::SQL_CTE_NAME
                        | AttributeKey::SQL_WINDOW_DEF_NAME
                        | AttributeKey::SQL_CREATE_FUNCTION_NAME
                        | AttributeKey::SQL_FUNCTION_PARAM_NAME
                ) {
                    completion.at_definition = true;
                    break;
                }
            }
        }

        // Is the previous symbol an inner dot and the cursor on the successor?
        if previous_symbol.is_some_and(|p| p.is_dot()) && expects_identifier {
            if matches!(
                target.relative_pos,
                RelativeSymbolPosition::END_OF_SYMBOL
                    | RelativeSymbolPosition::BEGIN_OF_SYMBOL
                    | RelativeSymbolPosition::MID_OF_SYMBOL
            ) {
                completion.dot_completion = true;
            }
        }

        completion.has_post_cursor_token = completion.compute_has_post_cursor_token();

        if completion.dot_completion {
            completion.find_candidates_for_name_path();
        } else if between_symbols {
            // Only expected keywords with an empty target, the passive inline hints
            if !suppress_passive_hint(target.symbol.kind) {
                completion
                    .add_expected_keywords_as_candidates(&expected_at_cursor.expected, &expected_at_cursor.prefix);
            }
        } else {
            completion.add_expected_keywords_as_candidates(&expected_at_cursor.expected, &expected_at_cursor.prefix);
            // An identity candidate with the text of the user
            if expects_identifier {
                let sym = target.symbol;
                let mut symbol_text = completion.text_at(sym.location.offset, sym.location.length);
                if symbol_text.len() > MAX_IDENTITY_LENGTH {
                    symbol_text = &[];
                }
                if !symbol_text.is_empty() {
                    let identity_score = if completion.at_definition {
                        Score::MAX
                    } else {
                        match completion.strategy {
                            CompletionStrategy::TABLE_REF => IDENTITY_SCORE_TABLE_REF,
                            CompletionStrategy::COLUMN_REF => IDENTITY_SCORE_COLUMN_REF,
                            CompletionStrategy::TABLE_REF_ALIAS => IDENTITY_SCORE_TABLE_REF_ALIAS,
                            _ => Score::MAX,
                        }
                    };
                    let location = Self::symbol_location(&sym);
                    let mut identity =
                        Candidate::new(text_arc(symbol_text), 0, CandidateTag::IDENTITY.0, location, location);
                    identity.completion_text_is_verbatim = true;
                    identity.score = identity_score;
                    completion.candidate_heap.insert(identity);
                }
            }
            // Search the name indexes when expecting an identifier that is not a definition or alias
            if expects_identifier
                && !completion.at_definition
                && completion.strategy != CompletionStrategy::TABLE_REF_ALIAS
            {
                completion.find_candidates_in_indexes();
                completion.find_candidates_in_scope();
                completion.find_candidates_in_inline_visualize_source();
                completion.promote_tables_and_peers_for_unresolved_columns();
            }
        }
        if !between_symbols {
            completion.promote_identifiers_in_scope();
        }
        completion.select_top_candidates();
        if !between_symbols {
            completion.qualify_top_candidates();
        }
        completion.derive_keyword_continuations(&expected_at_cursor.prefix);
        completion
    }

    /// Is there a real token after the feed point? (`computeHasPostCursorToken`)
    fn compute_has_post_cursor_token(&self) -> bool {
        let Some(target) = self.target_symbol else { return false };
        let replace_target = matches!(
            target.relative_pos,
            RelativeSymbolPosition::BEGIN_OF_SYMBOL
                | RelativeSymbolPosition::MID_OF_SYMBOL
                | RelativeSymbolPosition::END_OF_SYMBOL
        );
        let mut post_id = target.symbol_id;
        if (target.relative_pos == RelativeSymbolPosition::AFTER_SYMBOL || replace_target)
            && !self.is_at_eof(target.symbol_id)
        {
            post_id = self.next_symbol(target.symbol_id);
        }
        if self.is_at_eof(post_id) {
            return false;
        }
        self.symbols()[post_id as usize].kind != S_YYEOF
    }

    /// The feed point and whether feeding replaces the target token
    fn feed_point(&self) -> (u32, bool) {
        let target = self.target_symbol.unwrap();
        let replace_target = matches!(
            target.relative_pos,
            RelativeSymbolPosition::BEGIN_OF_SYMBOL
                | RelativeSymbolPosition::MID_OF_SYMBOL
                | RelativeSymbolPosition::END_OF_SYMBOL
        );
        let mut feed_id = target.symbol_id;
        if target.relative_pos == RelativeSymbolPosition::AFTER_SYMBOL && !self.is_at_eof(target.symbol_id) {
            feed_id = self.next_symbol(target.symbol_id);
        }
        (feed_id, replace_target)
    }

    /// Add the expected keywords to the heap (`AddExpectedKeywordsAsCandidates`)
    fn add_expected_keywords_as_candidates(&mut self, symbols: &[SymbolKind], prefix: &PrefixSnapshot) {
        let target = self.target_symbol.unwrap();
        let (feed_id, replace_target) = self.feed_point();

        // The match tags of a keyword against the typed text
        let typed_text: &[u8] = {
            let symbol_ofs = target.symbol.location.offset;
            let symbol_prefix = target.text_offset.max(symbol_ofs) - symbol_ofs;
            trim_double_quotes(self.text_at(symbol_ofs, symbol_prefix))
        };
        let keyword_tags = |keyword: SymbolKind, text: &str| -> CandidateTags {
            let mut tags = CandidateTag::EXPECTED_PARSER_SYMBOL.0 | keyword_prevalence(keyword).0;
            match target.relative_pos {
                RelativeSymbolPosition::BEGIN_OF_SYMBOL
                | RelativeSymbolPosition::MID_OF_SYMBOL
                | RelativeSymbolPosition::END_OF_SYMBOL => {
                    let typed = typed_text;
                    if !typed.is_empty() {
                        if let Some(t) = match_tags(text.as_bytes(), typed) {
                            tags |= t;
                        }
                    }
                    tags
                }
                _ => tags,
            }
        };

        let target_loc = if self.between_symbols {
            SymbolSpan::new(self.cursor.text_offset as u32, 0)
        } else {
            Self::symbol_location(&target.symbol)
        };
        let inside_select = self.cursor.script.parsed.is_some_and(|parsed| {
            self.cursor
                .ast_path_to_root
                .iter()
                .any(|&n| parsed.nodes[n as usize].node_type() == NodeType::OBJECT_SQL_SELECT)
        });

        // Probe the keywords against the tokens after the cursor
        let mut probes = Vec::new();
        let mut probe_input_idx = Vec::new();
        if self.has_post_cursor_token {
            let mut kinds = Vec::new();
            for (i, &s) in symbols.iter().enumerate() {
                if Keyword::name_of(s).is_some_and(|n| !n.is_empty()) {
                    kinds.push(s);
                    probe_input_idx.push(i);
                }
            }
            if !kinds.is_empty() {
                probes = probe::probe_suffix_batch(self.symbols(), feed_id, prefix, &kinds, replace_target);
            }
        }
        let mut next_probe = 0;

        for (i, &expected) in symbols.iter().enumerate() {
            let Some(name) = Keyword::name_of(expected).filter(|n| !n.is_empty()) else { continue };
            let mut tags = keyword_tags(expected, name);
            // A leading FROM is no proactive suggestion outside of a SELECT
            if expected == S_FROM && !inside_select && !has(tags, CandidateTag::SUBSTRING_MATCH) {
                continue;
            }
            if next_probe < probes.len() && probe_input_idx[next_probe] == i {
                let probe = probes[next_probe];
                next_probe += 1;
                if !probe.k1_compatible {
                    tags |= CandidateTag::SUFFIX_INCOMPATIBLE.0;
                } else if probe.reached_eof || probe.depth_consumed >= 2 {
                    tags |= CandidateTag::SUFFIX_DEPTH_MANY.0;
                } else if probe.depth_consumed == 1 {
                    tags |= CandidateTag::SUFFIX_DEPTH_ONE.0;
                }
            }
            let mut candidate = Candidate::new(Arc::from(name), 0, tags, target_loc, target_loc);
            candidate.score = compute_candidate_score(tags);
            candidate.keyword_symbol = Some(expected);
            self.candidate_heap.insert(candidate);
        }
    }

    /// The text typed before the cursor in the target symbol, without double quotes
    /// (`ReadTargetPrefix`)
    fn read_target_prefix(&self) -> &'a [u8] {
        let Some(target) = self.target_symbol else { return &[] };
        let symbol_ofs = target.symbol.location.offset;
        let symbol_len = target.symbol.location.length;
        let cursor = self.cursor.text_offset as u32;
        let safe_cursor = cursor.max(symbol_ofs).min(symbol_ofs + symbol_len);
        let symbol_text = self.text_at(symbol_ofs, symbol_len);
        let prefix_len = ((safe_cursor.max(symbol_ofs) - symbol_ofs) as usize).min(symbol_text.len());
        trim_double_quotes(&symbol_text[..prefix_len])
    }

    /// Find candidates in a name search index (`findCandidatesInIndex`)
    fn find_candidates_in_index(&mut self, index: &NameSearchIndex, through_catalog: bool) {
        let target = self.target_symbol.unwrap();
        let symbol_ofs = target.symbol.location.offset;
        let symbol_text = self.text_at(symbol_ofs, target.symbol.location.length);
        let prefix_text = self.read_target_prefix();
        // Fall back to the full word if the cursor prefix is empty
        let search_text = if prefix_text.is_empty() { trim_double_quotes(symbol_text) } else { prefix_text };

        for name in index.search(search_text) {
            // Skip the name under the cursor itself
            if !through_catalog
                && name.occurrences == 1
                && target.text_offset >= name.location.offset
                && target.text_offset <= name.location.offset + name.location.length
            {
                continue;
            }
            let mut tags = CandidateTag::NAME_INDEX.0;
            if through_catalog {
                tags |= CandidateTag::THROUGH_CATALOG.0;
            }
            if matches!(
                target.relative_pos,
                RelativeSymbolPosition::BEGIN_OF_SYMBOL
                    | RelativeSymbolPosition::MID_OF_SYMBOL
                    | RelativeSymbolPosition::END_OF_SYMBOL
            ) {
                tags |= CandidateTag::SUBSTRING_MATCH.0;
                if ci_starts_with(name.text.as_bytes(), prefix_text) {
                    tags |= CandidateTag::PREFIX_MATCH.0;
                    if prefix_text.len() == name.text.len() {
                        tags |= CandidateTag::EXACT_MATCH.0;
                    }
                }
            }
            let candidate = match self.candidates_by_name.get(&name.text) {
                Some(&c) => {
                    let candidate = &mut self.candidates[c];
                    candidate.coarse_name_tags |= name.tags.0;
                    candidate.candidate_tags |= tags;
                    c
                }
                None => {
                    let location = Self::symbol_location(&target.symbol);
                    self.candidates.push(Candidate::new(name.text.clone(), name.tags.0, tags, location, location));
                    let c = self.candidates.len() - 1;
                    self.candidates_by_name.insert(name.text.clone(), c);
                    c
                }
            };
            for &object in &name.objects {
                let Some((object_id, candidate_object)) = self.index_object(object) else { continue };
                if let Some(&co) = self.candidate_objects_by_id.get(&object_id) {
                    self.candidate_objects[co].candidate_tags |= tags;
                    continue;
                }
                self.add_object(candidate, tags, object_id, candidate_object);
            }
        }
    }

    /// Find candidates in the indexes of the script and the catalog (`FindCandidatesInIndexes`)
    fn find_candidates_in_indexes(&mut self) {
        let Some(analyzed) = self.analyzed() else { return };
        self.find_candidates_in_index(analyzed.name_search_index(), false);
        for (_, entry) in self.catalog().entries_ranked() {
            if let CatalogEntryRef::Script(script) = entry {
                if Arc::ptr_eq(script, analyzed) {
                    continue;
                }
            }
            self.find_candidates_in_index(entry.name_search_index(), true);
        }
    }

    /// Add or merge a candidate without catalog objects (`AddLocalCandidate`)
    fn add_local_candidate(
        &mut self,
        name: &Arc<str>,
        name_tags: u8,
        mut tags: CandidateTags,
        prefix: &[u8],
        location: SymbolSpan,
        qualified: SymbolSpan,
    ) {
        if !prefix.is_empty() {
            match match_tags(name.as_bytes(), prefix) {
                Some(t) => tags |= t,
                None => return,
            }
        }
        match self.candidates_by_name.get(name) {
            Some(&c) => {
                let candidate = &mut self.candidates[c];
                candidate.coarse_name_tags |= name_tags;
                candidate.candidate_tags |= tags;
                // A visible local relation shadows catalog objects with the same spelling
                candidate.catalog_objects.clear();
                candidate.target_location = location;
                candidate.target_location_qualified = qualified;
            }
            None => {
                self.candidates.push(Candidate::new(name.clone(), name_tags, tags, location, qualified));
                self.candidates_by_name.insert(name.clone(), self.candidates.len() - 1);
            }
        }
    }

    /// The output column names of a CTE or derived table source (`forEachResolvedCTEColumn`)
    fn derived_columns(analyzed: &AnalyzedScript, source: &ScopeSource) -> Vec<Arc<str>> {
        let (child, aliases) = match &source.table {
            ReferencedTable::Cte(loc) => {
                let cte = analyzed.name_scopes[loc.scope as usize].cte_definitions.at(loc.index as usize);
                let Some(child) = cte.child_scope else { return Vec::new() };
                let aliases = if source.column_aliases.is_empty() { &cte.column_aliases } else { &source.column_aliases };
                (child, aliases)
            }
            ReferencedTable::Subquery(child) => (*child, &source.column_aliases),
            ReferencedTable::Table(_) | ReferencedTable::Unresolved(_) => return Vec::new(),
        };
        let outputs = &analyzed.name_scopes[child as usize].output_columns;
        let mut names = Vec::new();
        for (i, output) in outputs.iter().enumerate() {
            let name = aliases.get(i).unwrap_or(&output.column_name);
            if !name.text.is_empty() {
                names.push(name.text.clone());
            }
        }
        names
    }

    /// Is a scope within another one? (`isScopeWithin`)
    fn is_scope_within(analyzed: &AnalyzedScript, scope: u32, ancestor: Option<u32>) -> bool {
        let mut current = Some(scope);
        while let Some(c) = current {
            if Some(c) == ancestor {
                return true;
            }
            current = analyzed.name_scopes[c as usize].parent_scope;
        }
        false
    }

    /// Add CTEs and the columns of CTE sources in scope (`FindCandidatesInScope`)
    fn find_candidates_in_scope(&mut self) {
        let cursor = self.cursor;
        let (Some(target), Some(parsed), Some(analyzed)) = (self.target_symbol, cursor.script.parsed, self.analyzed())
        else {
            return;
        };
        let prefix = self.read_target_prefix();
        let location = Self::symbol_location(&target.symbol);
        let tags = CandidateTag::NAME_INDEX.0 | CandidateTag::IN_NAME_SCOPE.0;

        if self.strategy == CompletionStrategy::TABLE_REF {
            // Non-recursive CTEs are visible after their definition and not within themselves
            let scanned = &parsed.scanned;
            for &scope_id in &cursor.name_scopes {
                let scope = &analyzed.name_scopes[scope_id as usize];
                for (_, cte) in scope.cte_definitions.iter() {
                    let Some(&cte_node) = scope.cte_definition_nodes.get(&cte.cte_name.text) else { continue };
                    let cte_text = resolve_text_span(
                        &scanned.text,
                        &scanned.symbols,
                        *parsed.nodes[cte_node as usize].symbol_span(),
                    );
                    if !scope.ctes_recursive && cte_text.offset as usize >= cursor.text_offset {
                        continue;
                    }
                    if !scope.ctes_recursive && Self::is_scope_within(analyzed, cursor.name_scopes[0], cte.child_scope)
                    {
                        continue;
                    }
                    self.add_local_candidate(
                        &cte.cte_name.text,
                        NameTag::TABLE_NAME.0,
                        tags,
                        prefix,
                        location,
                        location,
                    );
                }
            }
            return;
        }
        if self.strategy != CompletionStrategy::COLUMN_REF {
            return;
        }
        // The columns of CTE and derived table sources, catalog columns come from the name index
        for &scope_id in &cursor.name_scopes {
            let scope = &analyzed.name_scopes[scope_id as usize];
            for source in &scope.sources {
                for name in Self::derived_columns(analyzed, source) {
                    self.add_local_candidate(&name, NameTag::COLUMN_NAME.0, tags, prefix, location, location);
                }
            }
        }
    }

    /// Add the output columns of the inline SELECT of a VISUALIZE statement
    /// (`FindCandidatesInInlineVisualizeSource`)
    fn find_candidates_in_inline_visualize_source(&mut self) {
        let (Some(target), Some(parsed), Some(analyzed)) =
            (self.target_symbol, self.cursor.script.parsed, self.analyzed())
        else {
            return;
        };
        let nodes = &parsed.nodes;
        let path = &self.cursor.ast_path_to_root;
        if !path.iter().any(|&n| nodes[n as usize].attribute_key() == AttributeKey::VIS_VISUALISE_SPEC) {
            return;
        }
        let mut source_scope = None;
        for &node_id in path {
            let node = &nodes[node_id as usize];
            if node.node_type() != NodeType::OBJECT_VIS_VISUALISE {
                continue;
            }
            for i in 0..node.children_count() {
                let child_id = node.children_begin_or_value() + i;
                if nodes[child_id as usize].attribute_key() != AttributeKey::VIS_VISUALISE_SELECT {
                    continue;
                }
                source_scope = analyzed.name_scopes_by_root_node.get(&child_id).copied();
                break;
            }
            break;
        }
        let Some(source_scope) = source_scope else { return };
        let prefix = self.read_target_prefix();
        let location = Self::symbol_location(&target.symbol);
        let names: Vec<Arc<str>> = analyzed.name_scopes[source_scope as usize]
            .output_columns
            .iter()
            .map(|o| o.column_name.text.clone())
            .collect();
        for name in names {
            let tags = CandidateTag::NAME_INDEX.0 | CandidateTag::IN_NAME_SCOPE.0;
            self.add_local_candidate(&name, NameTag::COLUMN_NAME.0, tags, prefix, location, location);
        }
    }

    /// The name scopes around the cursor with the FROM items that the column refs of the cursor can see in them.
    /// The innermost scope comes first, a correlation barrier hides all scopes above it.
    fn visible_scopes(analyzed: &AnalyzedScript, name_scopes: &[ScopeId]) -> Vec<(ScopeId, SourceVisibility)> {
        let mut visible = Vec::with_capacity(name_scopes.len());
        let mut visibility = SourceVisibility::All;
        for &scope_id in name_scopes {
            visible.push((scope_id, visibility));
            let scope = &analyzed.name_scopes[scope_id as usize];
            if scope.column_correlation_barrier {
                break;
            }
            visibility = scope.parent_visibility;
        }
        visible
    }

    /// Promote names in the current name scopes (`PromoteIdentifiersInScope`)
    fn promote_identifiers_in_scope(&mut self) {
        let cursor = self.cursor;
        let Some(analyzed) = self.analyzed() else { return };
        let in_insert_source =
            self.cursor.name_scopes.iter().any(|&s| analyzed.name_scopes[s as usize].column_correlation_barrier);
        let promote = |completion: &mut Self, object_id: QualifiedCatalogObjectId| {
            if let Some(&co) = completion.candidate_objects_by_id.get(&object_id) {
                let candidate = completion.candidate_objects[co].candidate;
                completion.candidate_objects[co].candidate_tags |= CandidateTag::IN_NAME_SCOPE.0;
                completion.candidates[candidate].candidate_tags |= CandidateTag::IN_NAME_SCOPE.0;
            }
        };
        for (scope_id, visibility) in Self::visible_scopes(analyzed, &cursor.name_scopes) {
            let scope = &analyzed.name_scopes[scope_id as usize];
            // Columns of resolved table refs in scope
            for &table_ref_id in &scope.table_references {
                let table_ref = &analyzed.table_references[table_ref_id as usize];
                if !visibility.sees_node(table_ref.ast_node_id) {
                    continue;
                }
                if in_insert_source && table_ref.role == TableRole::Write {
                    continue;
                }
                let Some(resolved) = table_ref.inner.as_ref().and_then(|r| r.resolved_table.as_ref()) else { continue };
                let table_id = resolved.catalog_table_id.unpack_table_id();
                // Only tables of the catalog, the script itself is not necessarily published
                let Some(table) = self.catalog().table_by_id(table_id) else { continue };
                for i in 0..table.table_columns.len() as u32 {
                    promote(self, QualifiedCatalogObjectId::table_column(table_id, i));
                }
            }
            // Resolved column refs in scope
            for &expr in &scope.expressions {
                let Some(column_ref) = analyzed.expressions[expr as usize].column_ref() else { continue };
                let ColumnResolution::TableColumn(loc) = column_ref.resolved else { continue };
                let Some(table) = self.table(loc.table) else { continue };
                let object_id = table.table_columns[loc.column as usize].object_id;
                promote(self, object_id);
            }
        }
    }

    /// Promote tables that resolve unresolved columns, and their columns
    /// (`PromoteTablesAndPeersForUnresolvedColumns`)
    fn promote_tables_and_peers_for_unresolved_columns(&mut self) {
        let cursor = self.cursor;
        let (Some(_), Some(analyzed), Some(parsed)) = (cursor.statement_id, self.analyzed(), cursor.script.parsed)
        else {
            return;
        };
        let nodes = &parsed.nodes;
        let in_visualize_source = self
            .cursor
            .ast_path_to_root
            .iter()
            .any(|&n| nodes[n as usize].attribute_key() == AttributeKey::VIS_VISUALISE_SELECT);
        let mut columns = Vec::new();
        for &scope_id in &cursor.name_scopes {
            let scope = &analyzed.name_scopes[scope_id as usize];
            if in_visualize_source && nodes[scope.ast_node_id as usize].node_type() == NodeType::OBJECT_VIS_VISUALISE {
                continue;
            }
            for &expr in &scope.expressions {
                let Some(column_ref) = analyzed.expressions[expr as usize].column_ref() else { continue };
                if column_ref.resolved.is_resolved() {
                    continue;
                }
                columns.clear();
                self.resolve_table_columns_with_catalog(
                    analyzed,
                    &column_ref.column_name.column_name.text,
                    &mut columns,
                );
                for &column in &columns {
                    let Some(table) = self.table(column.table) else { continue };
                    if let Some(&co) = self.candidate_objects_by_id.get(&table.object_id) {
                        let candidate = self.candidate_objects[co].candidate;
                        self.candidate_objects[co].candidate_tags |= CandidateTag::RESOLVING_TABLE.0;
                        self.candidates[candidate].candidate_tags |= CandidateTag::RESOLVING_TABLE.0;
                    }
                    for peer in &table.table_columns {
                        if let Some(&co) = self.candidate_objects_by_id.get(&peer.object_id) {
                            let candidate = self.candidate_objects[co].candidate;
                            self.candidate_objects[co].candidate_tags |= CandidateTag::UNRESOLVED_PEER.0;
                            self.candidates[candidate].candidate_tags |= CandidateTag::UNRESOLVED_PEER.0;
                        }
                    }
                }
            }
        }
    }

    /// The table columns with a name in the catalog entries by rank, then in the script
    /// (`ResolveTableColumnsWithCatalog`)
    fn resolve_table_columns_with_catalog(&self, analyzed: &Arc<AnalyzedScript>, name: &str, out: &mut Vec<ColumnLoc>) {
        for (_, entry) in self.catalog().entries_ranked() {
            if let CatalogEntryRef::Script(script) = entry {
                if Arc::ptr_eq(script, analyzed) {
                    continue;
                }
            }
            entry.data().resolve_table_columns(name, out);
        }
        analyzed.entry.resolve_table_columns(name, out);
    }

    /// Tables of a schema in any database, the own script first (`ResolveSchemaTablesWithCatalog`)
    fn resolve_schema_tables(&self, analyzed: &AnalyzedScript, schema: &str, out: &mut Vec<(TableLoc, bool)>) {
        let own = &analyzed.entry;
        let lower = (Arc::<str>::from(schema), Arc::<str>::from(""));
        for ((s, _), tables) in own.tables_by_unqualified_schema.range(lower..) {
            if &**s != schema {
                break;
            }
            out.extend(tables.iter().map(|&t| (own.table_loc(t), false)));
        }
        let lower = (Arc::<str>::from(schema), 0, 0);
        for ((s, _, entry_id), _) in self.catalog().entries_by_schema().range(lower..) {
            if &**s != schema {
                break;
            }
            if *entry_id == own.catalog_entry_id {
                continue;
            }
            let Some(other) = self.catalog().entry(*entry_id) else { continue };
            let other = other.data();
            let lower = (Arc::<str>::from(schema), Arc::<str>::from(""));
            for ((s, _), tables) in other.tables_by_unqualified_schema.range(lower..) {
                if &**s != schema {
                    break;
                }
                out.extend(tables.iter().map(|&t| (other.table_loc(t), true)));
            }
        }
    }

    /// Tables of a qualified schema, the own script first (`ResolveSchemaTablesWithCatalog`)
    fn resolve_qualified_schema_tables(
        &self,
        analyzed: &AnalyzedScript,
        database: &str,
        schema: &str,
        out: &mut Vec<(TableLoc, bool)>,
    ) {
        let own = &analyzed.entry;
        let key = (Arc::<str>::from(schema), Arc::<str>::from(database));
        if let Some(tables) = own.tables_by_unqualified_schema.get(&key) {
            out.extend(tables.iter().map(|&t| (own.table_loc(t), false)));
        }
        let lower = (Arc::<str>::from(database), Arc::<str>::from(schema), 0, 0);
        let upper = (Arc::<str>::from(database), Arc::<str>::from(schema), Rank::MAX, CatalogEntryId::MAX);
        for ((_, _, _, entry_id), _) in self.catalog().entries_by_qualified_schema().range(lower..=upper) {
            if *entry_id == own.catalog_entry_id {
                continue;
            }
            let Some(other) = self.catalog().entry(*entry_id) else { continue };
            let other = other.data();
            if let Some(tables) = other.tables_by_unqualified_schema.get(&key) {
                out.extend(tables.iter().map(|&t| (other.table_loc(t), true)));
            }
        }
    }

    /// Schemas of a database, the own script first (`ResolveDatabaseSchemasWithCatalog`)
    fn resolve_database_schemas(
        &self,
        analyzed: &AnalyzedScript,
        database: &str,
    ) -> Vec<(Arc<str>, QualifiedCatalogObjectId, bool)> {
        let mut out = Vec::new();
        let lower = (Arc::<str>::from(database), Arc::<str>::from(""));
        for ((db, _), &i) in analyzed.entry.schemas_by_qualified_name.range(lower.clone()..) {
            if &**db != database {
                break;
            }
            let schema = &analyzed.entry.schema_references[i];
            out.push((schema.schema_name.clone(), schema.object_id, false));
        }
        for ((db, _), schema) in self.catalog().schemas().range(lower..) {
            if &**db != database {
                break;
            }
            out.push((schema.schema_name.clone(), schema.object_id, true));
        }
        out
    }

    /// Complete a name path after a dot (`FindCandidatesForNamePath`)
    fn find_candidates_for_name_path(&mut self) {
        let cursor = self.cursor;
        let Some(analyzed) = self.analyzed() else { return };
        let scanned = cursor.script.scanned.unwrap();
        let target = self.target_symbol.unwrap();

        // A recovered `alias.` context without a column ref node: resolve the alias in the scopes
        if let CursorContext::ColumnRef { expression_id: u32::MAX } = cursor.context {
            let Some(location) = cursor.scanner_location else { return };
            let Some(dot) = ScriptCursor::dot_symbol(&location, &target) else { return };
            let (alias_begin, alias_end) =
                crate::cursor::qualifier_before(&scanned.text, dot.symbol.location.offset as usize);
            let alias_text = &scanned.text[alias_begin..alias_end];
            // The qualifier is sealed, only the text after the dot is replaced
            let replace_at = SymbolSpan::new(cursor.text_offset as u32, 0);
            let qualified_at = SymbolSpan::new(alias_begin as u32, (cursor.text_offset - alias_begin) as u32);
            let tags = CandidateTag::DOT_RESOLUTION_COLUMN.0 | CandidateTag::IN_NAME_SCOPE.0;
            for &scope_id in &cursor.name_scopes {
                let scope = &analyzed.name_scopes[scope_id as usize];
                let Some(source) = scope.source(alias_text) else { continue };
                match &source.table {
                    ReferencedTable::Table(loc) => {
                        let names: Vec<Arc<str>> = self
                            .table(*loc)
                            .map(|t| {
                                let names = t.table_columns.iter().map(|c| &c.column_name);
                                let names = source.column_aliases.iter().chain(names.skip(source.column_aliases.len()));
                                names.map(|n| n.text.clone()).collect()
                            })
                            .unwrap_or_default();
                        for name in names {
                            self.add_local_candidate(
                                &name,
                                NameTag::COLUMN_NAME.0,
                                tags,
                                &[],
                                replace_at,
                                qualified_at,
                            );
                        }
                    }
                    ReferencedTable::Cte(_) | ReferencedTable::Subquery(_) => {
                        for name in Self::derived_columns(analyzed, source) {
                            self.add_local_candidate(
                                &name,
                                NameTag::COLUMN_NAME.0,
                                tags,
                                &[],
                                replace_at,
                                qualified_at,
                            );
                        }
                    }
                    ReferencedTable::Unresolved(_) => {}
                }
                return;
            }
            return;
        }

        let cursor_location = target.text_offset;
        let mut name_path_loc = SymbolSpan::default();
        let name_path = cursor.read_cursor_name_path(&mut name_path_loc);
        let resolve = |span: SymbolSpan| resolve_text_span(&scanned.text, &scanned.symbols, span);

        // Count the names and the sealed names before the cursor
        let mut name_count = 0;
        let mut sealed = 0;
        let mut last_text_prefix: &[u8] = &[];
        let name_path_ts = resolve(name_path_loc);
        let mut truncate_at = name_path_ts.offset + name_path_ts.length;
        while name_count < name_path.len() {
            let component = &name_path[name_count];
            let comp_ts = resolve(component.loc);
            if component.component_type == NameComponentType::TrailingDot {
                truncate_at = comp_ts.offset + 1;
                break;
            }
            if component.component_type != NameComponentType::Name {
                truncate_at = comp_ts.offset;
                break;
            }
            if comp_ts.offset + comp_ts.length < cursor_location {
                sealed += 1;
            } else {
                // The cursor points into a name, complete the text left of the cursor
                let last_text = self.text_at(comp_ts.offset, comp_ts.length);
                let last_content = last_text.iter().position(|&c| c != b'"').unwrap_or(last_text.len());
                let last_content_ofs = comp_ts.offset as usize + last_content;
                let prefix_length = (cursor_location as usize).max(last_content_ofs) - last_content_ofs;
                let end = (last_content + prefix_length).min(last_text.len());
                last_text_prefix = &last_text[last_content..end];
                truncate_at = comp_ts.offset;
                break;
            }
            name_count += 1;
        }
        let name_path = &name_path[..name_count];

        // The text ranges to replace
        let script_length = scanned.text.len() as u32;
        let name_path_end = (name_path_ts.offset + name_path_ts.length).min(script_length);
        let replace_text_at = SymbolSpan::new(truncate_at, name_path_end.max(truncate_at) - truncate_at);
        let name_path_text_loc =
            SymbolSpan::new(name_path_ts.offset, name_path_end.max(name_path_ts.offset) - name_path_ts.offset);
        if name_path.is_empty() {
            return;
        }

        let name_text = |i: usize| -> &str { analyzed.name_text(name_path[i].name.unwrap()) };
        let mut dot_candidates: Vec<DotCandidate> = Vec::new();
        match cursor.context {
            CursorContext::TableRef { .. } => match sealed {
                1 => {
                    // a._: a is a schema in the default database or a database
                    let a = name_text(0);
                    let mut tables = Vec::new();
                    self.resolve_schema_tables(analyzed, a, &mut tables);
                    for (loc, through_catalog) in tables {
                        let Some(table) = self.table(loc) else { continue };
                        let mut tags = CandidateTag::DOT_RESOLUTION_TABLE.0;
                        if through_catalog {
                            tags |= CandidateTag::THROUGH_CATALOG.0;
                        }
                        dot_candidates.push(DotCandidate {
                            name: table.table_name.table_name.text.clone(),
                            candidate_tags: tags,
                            name_tags: NameTag::TABLE_NAME.0,
                            object_id: table.object_id,
                            object: CandidateObjectRef::Table(loc),
                        });
                    }
                    for (name, object_id, through_catalog) in self.resolve_database_schemas(analyzed, a) {
                        let mut tags = CandidateTag::DOT_RESOLUTION_SCHEMA.0;
                        if through_catalog {
                            tags |= CandidateTag::THROUGH_CATALOG.0;
                        }
                        dot_candidates.push(DotCandidate {
                            name,
                            candidate_tags: tags,
                            name_tags: NameTag::SCHEMA_NAME.0,
                            object_id,
                            object: CandidateObjectRef::Schema(object_id),
                        });
                    }
                }
                2 => {
                    // a.b._: a is a database, b a schema
                    let (a, b) = (name_text(0), name_text(1));
                    let mut tables = Vec::new();
                    self.resolve_qualified_schema_tables(analyzed, a, b, &mut tables);
                    for (loc, through_catalog) in tables {
                        let Some(table) = self.table(loc) else { continue };
                        let mut tags = CandidateTag::DOT_RESOLUTION_TABLE.0;
                        if through_catalog {
                            tags |= CandidateTag::THROUGH_CATALOG.0;
                        }
                        dot_candidates.push(DotCandidate {
                            name: table.table_name.table_name.text.clone(),
                            candidate_tags: tags,
                            name_tags: NameTag::TABLE_NAME.0,
                            object_id: table.object_id,
                            object: CandidateObjectRef::Table(loc),
                        });
                    }
                }
                _ => {}
            },
            CursorContext::ColumnRef { .. } => {
                if sealed == 1 {
                    // a._: a might be a table alias
                    let a = name_text(0);
                    for (scope_id, visibility) in Self::visible_scopes(analyzed, &cursor.name_scopes) {
                        let scope = &analyzed.name_scopes[scope_id as usize];
                        if let Some(source) = scope.sources.iter().find(|s| visibility.sees(s) && s.name.as_deref() == Some(a)) {
                            match &source.table {
                                ReferencedTable::Table(loc) => {
                                    if let Some(decl) = self.table(*loc) {
                                        let through_catalog = decl.table_id().origin != analyzed.catalog_entry_id();
                                        for (i, column) in decl.table_columns.iter().enumerate() {
                                            let mut tags = CandidateTag::DOT_RESOLUTION_COLUMN.0;
                                            if through_catalog {
                                                tags |= CandidateTag::THROUGH_CATALOG.0;
                                            }
                                            // Column aliases rename the leading columns
                                            let name = source.column_aliases.get(i).unwrap_or(&column.column_name);
                                            dot_candidates.push(DotCandidate {
                                                name: name.text.clone(),
                                                candidate_tags: tags,
                                                name_tags: NameTag::COLUMN_NAME.0,
                                                object_id: column.object_id,
                                                object: CandidateObjectRef::Column(ColumnLoc {
                                                    table: *loc,
                                                    column: i as u32,
                                                }),
                                            });
                                        }
                                    }
                                }
                                ReferencedTable::Cte(_) | ReferencedTable::Subquery(_) => {
                                    let tags = CandidateTag::DOT_RESOLUTION_COLUMN.0 | CandidateTag::IN_NAME_SCOPE.0;
                                    for name in Self::derived_columns(analyzed, source) {
                                        self.add_local_candidate(
                                            &name,
                                            NameTag::COLUMN_NAME.0,
                                            tags,
                                            last_text_prefix,
                                            replace_text_at,
                                            name_path_text_loc,
                                        );
                                    }
                                }
                                ReferencedTable::Unresolved(_) => {}
                            }
                            break;
                        }
                    }
                }
            }
            CursorContext::None => {}
        }

        for mut dot_candidate in dot_candidates {
            if let Some(&co) = self.candidate_objects_by_id.get(&dot_candidate.object_id) {
                // Update the tags and the replacement target
                self.candidate_objects[co].candidate_tags |= dot_candidate.candidate_tags;
                let candidate = self.candidate_objects[co].candidate;
                self.candidates[candidate].target_location = replace_text_at;
                self.candidates[candidate].target_location_qualified = name_path_text_loc;
                continue;
            }
            if !last_text_prefix.is_empty() {
                if let Some(t) = match_tags(dot_candidate.name.as_bytes(), last_text_prefix) {
                    dot_candidate.candidate_tags |= t;
                }
            }
            let candidate = match self.candidates_by_name.get(&dot_candidate.name) {
                Some(&c) => {
                    let existing = &mut self.candidates[c];
                    existing.target_location = replace_text_at;
                    existing.target_location_qualified = name_path_text_loc;
                    existing.candidate_tags |= dot_candidate.candidate_tags;
                    c
                }
                None => {
                    self.candidates.push(Candidate::new(
                        dot_candidate.name.clone(),
                        dot_candidate.name_tags,
                        dot_candidate.candidate_tags,
                        replace_text_at,
                        name_path_text_loc,
                    ));
                    let c = self.candidates.len() - 1;
                    self.candidates_by_name.insert(dot_candidate.name.clone(), c);
                    c
                }
            };
            self.add_object(candidate, dot_candidate.candidate_tags, dot_candidate.object_id, dot_candidate.object);
        }
    }

    /// Score all candidates and select the top k (`SelectTopCandidates`)
    fn select_top_candidates(&mut self) {
        let scores = name_tag_scores(self.strategy);
        // Objects with higher scores first, then in the order they were found
        let mut object_heap =
            TopKHeap::new(24, |l: &(usize, Score), r: &(usize, Score)| l.1.cmp(&r.1).then(r.0.cmp(&l.0)));
        for i in 0..self.candidates.len() {
            // The base score is the maximum among the name tags
            let tags = self.candidates[i].coarse_name_tags;
            let mut base_score = 0;
            for (tag, tag_score) in scores {
                base_score = base_score.max(if tags & tag.0 != 0 { tag_score } else { 0 });
            }
            // The top catalog objects
            object_heap.clear();
            for &co in &self.candidates[i].catalog_objects {
                let score = compute_candidate_score(self.candidate_objects[co].candidate_tags);
                self.candidate_objects[co].score = score;
                object_heap.insert((co, score));
            }
            let objects: Vec<(usize, Score)> = object_heap.finish().clone();
            let candidate = &mut self.candidates[i];
            candidate.catalog_objects = objects.iter().map(|&(co, _)| co).collect();
            // The C++ core takes the score of the last, i.e. the lowest, of the top objects
            let object_score = match objects.last() {
                Some(&(_, score)) => score,
                None => compute_candidate_score(candidate.candidate_tags),
            };
            candidate.score = base_score + object_score;
            let candidate = candidate.clone();
            self.candidate_heap.insert(candidate);
        }
        self.candidate_heap.finish();
        self.top_candidates = self.candidate_heap.take_entries();
    }

    /// The qualified name of a table
    fn qualified_table_name(name: &QualifiedTableName) -> Vec<Arc<str>> {
        let mut names = Vec::with_capacity(4);
        if !name.database_name.text.is_empty() {
            names.push(name.database_name.text.clone());
            names.push(name.schema_name.text.clone());
            names.push(name.table_name.text.clone());
        } else if !name.schema_name.text.is_empty() {
            names.push(name.schema_name.text.clone());
            names.push(name.table_name.text.clone());
        } else if !name.table_name.text.is_empty() {
            names.push(name.table_name.text.clone());
        }
        names
    }

    /// Derive qualified names of the top candidates (`QualifyTopCandidates`)
    fn qualify_top_candidates(&mut self) {
        // The column candidates by the table that defines them: (table id, candidate object)
        let mut columns_by_table: Vec<(QualifiedCatalogObjectId, usize)> = Vec::new();
        for top in &self.top_candidates {
            let mut column_count_in_scope = 0;
            let mut table_count = 0;
            for &co in &top.catalog_objects {
                let object = &self.candidate_objects[co];
                let in_scope = has(object.candidate_tags, CandidateTag::IN_NAME_SCOPE);
                match object.object {
                    CandidateObjectRef::Column(loc) => {
                        column_count_in_scope += in_scope as usize;
                        columns_by_table.push((
                            QualifiedCatalogObjectId::table(object.catalog_object_id.unpack_table_column_id().0),
                            co,
                        ));
                        let table = self.table(loc.table);
                        let qualified = match table {
                            Some(table) => {
                                let mut names = Self::qualified_table_name(&table.table_name);
                                names.push(table.table_columns[loc.column as usize].column_name.text.clone());
                                names
                            }
                            None => Vec::new(),
                        };
                        let object = &mut self.candidate_objects[co];
                        object.qualified_name_target_idx = qualified.len().saturating_sub(1);
                        object.qualified_name = qualified;
                    }
                    CandidateObjectRef::Table(loc) => {
                        table_count += 1;
                        let qualified =
                            self.table(loc).map(|t| Self::qualified_table_name(&t.table_name)).unwrap_or_default();
                        let object = &mut self.candidate_objects[co];
                        object.qualified_name_target_idx = qualified.len().wrapping_sub(1);
                        object.qualified_name = qualified;
                    }
                    CandidateObjectRef::Function(loc) => {
                        let qualified = self
                            .entry_data(loc.entry)
                            .and_then(|d| d.function_declarations.get(loc.index as usize))
                            .map(|f| {
                                let name = &f.function_name;
                                let mut names = Vec::with_capacity(3);
                                if !name.database_name.text.is_empty() {
                                    names.push(name.database_name.text.clone());
                                    names.push(name.schema_name.text.clone());
                                    names.push(name.function_name.text.clone());
                                } else if !name.schema_name.text.is_empty() {
                                    names.push(name.schema_name.text.clone());
                                    names.push(name.function_name.text.clone());
                                } else if !name.function_name.text.is_empty() {
                                    names.push(name.function_name.text.clone());
                                }
                                names
                            })
                            .unwrap_or_default();
                        let object = &mut self.candidate_objects[co];
                        object.qualified_name_target_idx = qualified.len().wrapping_sub(1);
                        object.qualified_name = qualified;
                    }
                    _ => {}
                }
            }
            let prefer_qualified_columns = column_count_in_scope > 1;
            let prefer_qualified_tables = table_count > 1;
            for &co in &top.catalog_objects {
                let object = &mut self.candidate_objects[co];
                match object.object {
                    CandidateObjectRef::Column(_) => object.prefer_qualified = prefer_qualified_columns,
                    CandidateObjectRef::Table(_) => object.prefer_qualified = prefer_qualified_tables,
                    _ => {}
                }
            }
        }

        // Qualify column candidates with the aliases of the table refs in scope
        let Some(analyzed) = self.analyzed() else { return };
        for &scope_id in &self.cursor.name_scopes {
            let scope = &analyzed.name_scopes[scope_id as usize];
            for &table_ref_id in &scope.table_references {
                let table_ref = &analyzed.table_references[table_ref_id as usize];
                let Some(resolved) = table_ref.inner.as_ref().and_then(|r| r.resolved_table.as_ref()) else { continue };
                let mut has_match = false;
                for &(table_id, co) in &columns_by_table {
                    if table_id != resolved.catalog_table_id {
                        continue;
                    }
                    has_match = true;
                    let CandidateObjectRef::Column(loc) = self.candidate_objects[co].object else { continue };
                    let column_name = match self.table(loc.table) {
                        Some(t) => t.table_columns[loc.column as usize].column_name.text.clone(),
                        None => continue,
                    };
                    let object = &mut self.candidate_objects[co];
                    match &table_ref.alias {
                        Some((alias, _)) => {
                            object.qualified_name = vec![alias.text.clone(), column_name];
                            object.qualified_name_target_idx = 1;
                            object.prefer_qualified = true;
                        }
                        None => {
                            let mut names = Self::qualified_table_name(&resolved.table_name);
                            names.push(column_name);
                            object.qualified_name_target_idx = names.len() - 1;
                            object.qualified_name = names;
                        }
                    }
                }
                if has_match {
                    columns_by_table.retain(|&(table_id, _)| table_id != resolved.catalog_table_id);
                }
            }
        }
    }

    /// Derive keyword continuations of the top candidates (`DeriveKeywordContinuationsForTopCandidates`)
    fn derive_keyword_continuations(&mut self, prefix: &PrefixSnapshot) {
        let Some(target) = self.target_symbol else { return };
        let symbols = self.symbols();
        let target_id = if self.between_symbols && !self.is_at_eof(target.symbol_id) {
            self.next_symbol(target.symbol_id)
        } else {
            target.symbol_id
        };
        let (feed_id, replace_target) = self.feed_point();

        // The single keyword, or the uniquely best scored continuation
        let find_continuation = |expected: &[SymbolKind]| -> Option<SymbolKind> {
            let mut best = None;
            let mut best_score = 0;
            let mut best_count = 0;
            let mut keyword_count = 0;
            let mut unique = None;
            for &sym in expected {
                if Keyword::symbol_text(sym).is_none_or(|t| t.is_empty()) {
                    continue;
                }
                keyword_count += 1;
                unique = Some(sym);
                let score = keyword_continuation_score(sym);
                if score > best_score {
                    best_score = score;
                    best = Some(sym);
                    best_count = 1;
                } else if score == best_score && score > 0 {
                    best_count += 1;
                }
            }
            if keyword_count == 1 {
                return unique;
            }
            if best_count == 1 {
                return best;
            }
            None
        };
        // Keep a continuation only if the tokens after the cursor still parse after it
        let has_post_cursor_token = self.has_post_cursor_token;
        let fits_suffix = |candidate: SymbolKind, continuation: SymbolKind| -> bool {
            if !has_post_cursor_token {
                return true;
            }
            let probe =
                probe::probe_suffix_sequence(symbols, feed_id, prefix, &[candidate, continuation], replace_target);
            probe.k1_compatible || probe.reached_eof
        };

        let mut ident_continuation: Option<Option<&'static str>> = None;
        for candidate in self.top_candidates.iter_mut() {
            match candidate.keyword_symbol {
                Some(keyword) => {
                    let expected = probe::parse_until_after(symbols, target_id, keyword);
                    let Some(continuation) = find_continuation(&expected) else { continue };
                    if !fits_suffix(keyword, continuation) {
                        continue;
                    }
                    candidate.keyword_continuation = Keyword::symbol_text(continuation);
                }
                None => {
                    let text = *ident_continuation.get_or_insert_with(|| {
                        let expected = probe::parse_until_after(symbols, target_id, S_IDENT);
                        find_continuation(&expected).filter(|&c| fits_suffix(S_IDENT, c)).and_then(Keyword::symbol_text)
                    });
                    if let Some(text) = text.filter(|t| !t.is_empty()) {
                        candidate.keyword_continuation = Some(text);
                    }
                }
            }
        }
    }
}
