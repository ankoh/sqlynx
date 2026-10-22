//! Catalog changes implied by successful statements.
//!
//! A full catalog refresh can be expensive, so the catalog follows the DDL statements that the user
//! runs: a successful `CREATE TABLE`, `CREATE TABLE AS`, `CREATE VIEW`, `SELECT INTO` or `DROP`
//! becomes a [`CatalogChangeT`] that is applied to a descriptor entry. The changes of a connection
//! are kept as SQL, a script of `CREATE TABLE` and `DROP TABLE` statements that is
//! rendered and parsed with the same derivation.

use super::{Catalog, CatalogEntryId, Rank};
use crate::analyzer::AnalyzedScript;
use crate::error::{Error, Result};
use crate::pack::pack_parsed_statement;
use crate::script::Script;
use dashql_buffers::analyzer::{QualifiedTableNameT, TableColumnT, TableT};
use dashql_buffers::catalog::{CatalogChangeT, CatalogChangeType, CatalogDescriptor, CatalogDescriptorT};
use dashql_buffers::parser::{AttributeKey, Node, NodeType, StatementType, TempType};
use dashql_parser::parser::ParsedScript;

/// The header of rendered changes SQL
const CHANGES_SQL_HEADER: &str = "-- Catalog changes of executed statements";

/// How statements are turned into catalog changes
#[derive(Clone, Debug, Default)]
pub struct CatalogChangeOptions {
    /// Follow temporary relations? They only live as long as the database session.
    pub include_temporary: bool,
}

/// The names that qualify the relations of unqualified statements, they depend on the connection
#[derive(Clone, Debug, Default)]
pub struct CatalogNameDefaults {
    /// The database of relations without a database name
    pub database_name: String,
    /// The schema of relations without a schema name
    pub schema_name: String,
}

/// The children of a node
fn children<'a>(parsed: &'a ParsedScript, node: &Node) -> &'a [Node] {
    let begin = node.children_begin_or_value() as usize;
    &parsed.nodes[begin..begin + node.children_count() as usize]
}

/// The child of a node with an attribute key
fn attribute<'a>(parsed: &'a ParsedScript, node: &Node, key: AttributeKey) -> Option<&'a Node> {
    children(parsed, node).iter().find(|c| c.attribute_key() == key)
}

/// Is an attribute a `true` bool node?
fn is_true(node: Option<&Node>) -> bool {
    node.is_some_and(|n| n.node_type() == NodeType::BOOL && n.children_begin_or_value() != 0)
}

/// Does an attribute declare a temporary relation? `UNLOGGED` relations are persistent.
fn is_temporary(node: Option<&Node>) -> bool {
    node.is_some_and(|n| {
        n.node_type() == NodeType::ENUM_SQL_TEMP_TYPE
            && matches!(TempType(n.children_begin_or_value() as u8), TempType::DEFAULT | TempType::LOCAL | TempType::GLOBAL)
    })
}

/// The change of a statement, before the relation is named
struct StatementChange {
    /// The change type
    change_type: CatalogChangeType,
    /// Is the relation only created if it does not exist yet?
    if_not_exists: bool,
}

/// Classify a statement
fn classify_statement(parsed: &ParsedScript, statement_id: usize, include_temporary: bool) -> Option<StatementChange> {
    let statement = &parsed.statements[statement_id];
    let root = &parsed.nodes[statement.root as usize];
    let create = |temp: AttributeKey, if_not_exists: Option<AttributeKey>| {
        if !include_temporary && is_temporary(attribute(parsed, root, temp)) {
            return None;
        }
        Some(StatementChange {
            change_type: CatalogChangeType::CREATE_RELATION,
            if_not_exists: if_not_exists.is_some_and(|key| is_true(attribute(parsed, root, key))),
        })
    };
    match statement.statement_type {
        StatementType::CREATE_TABLE => create(AttributeKey::SQL_CREATE_TABLE_TEMP, Some(AttributeKey::SQL_CREATE_TABLE_IF_NOT_EXISTS)),
        StatementType::CREATE_TABLE_AS => create(AttributeKey::SQL_CREATE_AS_TEMP, Some(AttributeKey::SQL_CREATE_AS_IF_NOT_EXISTS)),
        StatementType::CREATE_VIEW => create(AttributeKey::SQL_VIEW_TEMP, None),
        StatementType::SELECT_INTO => {
            let into = attribute(parsed, root, AttributeKey::SQL_SELECT_INTO)?;
            if !include_temporary && is_temporary(attribute(parsed, into, AttributeKey::SQL_TEMP_TYPE)) {
                return None;
            }
            Some(StatementChange {
                change_type: CatalogChangeType::CREATE_RELATION,
                if_not_exists: false,
            })
        }
        StatementType::DROP_TABLE | StatementType::DROP_VIEW => Some(StatementChange {
            change_type: CatalogChangeType::DROP_RELATION,
            if_not_exists: false,
        }),
        _ => None,
    }
}

/// Derive the catalog change of a statement of an analyzed script.
///
/// The relation is named as written, see [`qualify_catalog_changes`]. Returns None for statements that
/// leave the catalog as it is, for excluded temporary relations, and for statements whose relation the
/// analysis could not name.
pub fn derive_catalog_change(analyzed: &AnalyzedScript, statement_id: usize, options: &CatalogChangeOptions) -> Option<CatalogChangeT> {
    let parsed = &analyzed.parsed;
    if statement_id >= parsed.statements.len() {
        return None;
    }
    let classified = classify_statement(parsed, statement_id, options.include_temporary)?;
    let target = pack_parsed_statement(parsed, statement_id).target?;
    let relation_name = target.relation_name.filter(|n| !n.is_empty())?;
    let mut change = CatalogChangeT::default();
    change.change_type = classified.change_type;
    change.database_name = Some(target.database_name.unwrap_or_default());
    change.schema_name = Some(target.schema_name.unwrap_or_default());
    change.relation_name = Some(relation_name);
    change.if_not_exists = classified.if_not_exists;
    if classified.change_type == CatalogChangeType::CREATE_RELATION {
        let table = analyzed
            .entry
            .table_declarations
            .iter()
            .find(|t| t.ast_statement_id == Some(statement_id as u32))?;
        // The analyzer sorts the columns of CREATE TABLE by name, the AST nodes restore the declaration order
        let mut columns: Vec<_> = table.table_columns.iter().collect();
        columns.sort_by_key(|c| c.ast_node_id.unwrap_or(u32::MAX));
        change.column_names = Some(columns.iter().map(|c| c.column_name.text.to_string()).collect());
    }
    Some(change)
}

/// Fill the missing database and schema names of changes with the defaults
pub fn qualify_catalog_changes(changes: &mut [CatalogChangeT], defaults: &CatalogNameDefaults) {
    for change in changes {
        for (name, default) in [
            (&mut change.database_name, &defaults.database_name),
            (&mut change.schema_name, &defaults.schema_name),
        ] {
            if name.as_deref().is_none_or(str::is_empty) {
                *name = Some(default.clone());
            }
        }
    }
}

/// The lookup key of a change: (database, schema, relation)
fn change_key(change: &CatalogChangeT) -> (&str, &str, &str) {
    (
        change.database_name.as_deref().unwrap_or(""),
        change.schema_name.as_deref().unwrap_or(""),
        change.relation_name.as_deref().unwrap_or(""),
    )
}

/// Compact changes to the last change of every relation, in the order of the last changes.
///
/// `IF NOT EXISTS` is resolved against the earlier changes of the same relation: after a creation it
/// changes nothing, after a drop it creates the relation unconditionally.
pub fn compact_catalog_changes(changes: Vec<CatalogChangeT>) -> Vec<CatalogChangeT> {
    let mut compacted: Vec<CatalogChangeT> = Vec::new();
    for mut change in changes {
        if change.change_type == CatalogChangeType::NONE {
            continue;
        }
        let previous = compacted.iter().position(|c| change_key(c) == change_key(&change));
        if let Some(previous) = previous {
            if change.if_not_exists {
                if compacted[previous].change_type == CatalogChangeType::CREATE_RELATION {
                    continue;
                }
                change.if_not_exists = false;
            }
            compacted.remove(previous);
        }
        compacted.push(change);
    }
    compacted
}

/// Quote an identifier
fn quote_identifier(identifier: &str, out: &mut String) {
    out.push('"');
    out.push_str(&identifier.replace('"', "\"\""));
    out.push('"');
}

/// Write the qualified name of a change
fn write_qualified_name(change: &CatalogChangeT, out: &mut String) {
    let (database, schema, relation) = change_key(change);
    if !database.is_empty() {
        quote_identifier(database, out);
        out.push('.');
    }
    if !schema.is_empty() || !database.is_empty() {
        quote_identifier(schema, out);
        out.push('.');
    }
    quote_identifier(relation, out);
}

/// Render compacted changes as SQL
pub fn render_catalog_changes_sql(changes: &[CatalogChangeT]) -> String {
    let mut out = String::from(CHANGES_SQL_HEADER);
    for change in changes {
        match change.change_type {
            CatalogChangeType::CREATE_RELATION => {
                out.push_str(if change.if_not_exists { "\n\nCREATE TABLE IF NOT EXISTS " } else { "\n\nCREATE TABLE " });
                write_qualified_name(change, &mut out);
                out.push_str(" (");
                for (i, column) in change.column_names.iter().flatten().enumerate() {
                    out.push_str(if i == 0 { "\n    " } else { ",\n    " });
                    quote_identifier(column, &mut out);
                    out.push_str(" VARCHAR");
                }
                out.push_str(if change.column_names.as_ref().is_some_and(|c| !c.is_empty()) { "\n);" } else { ");" });
            }
            CatalogChangeType::DROP_RELATION => {
                out.push_str("\n\nDROP TABLE ");
                write_qualified_name(change, &mut out);
                out.push(';');
            }
            _ => {}
        }
    }
    out.push('\n');
    out
}

/// Parse changes SQL into its changes. Its statements are fully qualified.
pub fn parse_catalog_changes_sql(text: &str) -> Result<Vec<CatalogChangeT>> {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text(text);
    script.analyze(&catalog, true)?;
    let analyzed = script.analyzed.clone().ok_or_else(|| Error::invalid_argument("catalog changes SQL is not analyzed"))?;
    if !analyzed.parsed.errors.is_empty() || !analyzed.parsed.scanned.errors.is_empty() {
        return Err(Error::invalid_argument("invalid catalog changes SQL"));
    }
    let options = CatalogChangeOptions::default();
    Ok((0..analyzed.parsed.statements.len())
        .filter_map(|id| derive_catalog_change(&analyzed, id, &options))
        .collect())
}

/// Append changes to changes SQL and compact it
pub fn append_catalog_changes_sql(changes_sql: &str, changes: &[CatalogChangeT]) -> Result<String> {
    let mut all = parse_catalog_changes_sql(changes_sql)?;
    all.extend(changes.iter().cloned());
    Ok(render_catalog_changes_sql(&compact_catalog_changes(all)))
}

/// Apply changes to the tables of a descriptor
fn apply_to_descriptor(descriptor: &mut CatalogDescriptorT, changes: &[CatalogChangeT]) {
    let tables = descriptor.tables.get_or_insert_with(Vec::new);
    for change in changes {
        let (database, schema, relation) = change_key(change);
        let position = tables.iter().position(|t| {
            let name = t.table_name.as_deref();
            let part = |f: fn(&QualifiedTableNameT) -> &Option<String>| name.and_then(|n| f(n).as_deref()).unwrap_or("");
            part(|n| &n.database_name) == database && part(|n| &n.schema_name) == schema && part(|n| &n.table_name) == relation
        });
        match change.change_type {
            CatalogChangeType::CREATE_RELATION => {
                if change.if_not_exists && position.is_some() {
                    continue;
                }
                let mut name = QualifiedTableNameT::default();
                name.database_name = Some(database.to_string());
                name.schema_name = Some(schema.to_string());
                name.table_name = Some(relation.to_string());
                let mut table = TableT::default();
                table.table_name = Some(Box::new(name));
                // A descriptor declares every column name once
                let mut seen = std::collections::HashSet::new();
                table.table_columns = Some(
                    change
                        .column_names
                        .iter()
                        .flatten()
                        .filter(|c| !c.is_empty() && seen.insert(c.as_str()))
                        .map(|c| {
                            let mut column = TableColumnT::default();
                            column.column_name = Some(c.clone());
                            column
                        })
                        .collect(),
                );
                match position {
                    Some(position) => tables[position] = table,
                    None => tables.push(table),
                }
            }
            CatalogChangeType::DROP_RELATION => {
                if let Some(position) = position {
                    tables.remove(position);
                }
            }
            _ => {}
        }
    }
}

impl Catalog {
    /// Apply catalog changes to a descriptor entry.
    /// An unknown entry is created with the given rank, a known entry keeps its rank.
    pub fn apply_catalog_changes(&mut self, id: CatalogEntryId, rank: Rank, changes: &[CatalogChangeT]) -> Result<()> {
        let (mut descriptor, rank) = match self.descriptor_entries.get(&id) {
            Some(entry) => {
                let descriptor = flatbuffers::root::<CatalogDescriptor>(&entry.bytes)
                    .map_err(|_| Error::invalid_argument("invalid CatalogDescriptor FlatBuffer"))?
                    .unpack();
                (descriptor, entry.rank)
            }
            None => (CatalogDescriptorT::default(), rank),
        };
        apply_to_descriptor(&mut descriptor, changes);
        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let packed = descriptor.pack(&mut builder);
        builder.finish(packed, None);
        self.replace_descriptor(id, rank, builder.finished_data())
    }
}
