//! The declarations of a catalog entry (`CatalogEntry` in `include/dashql/catalog.h`).
//!
//! Analyzed scripts and descriptor pools both expose their declarations through [`CatalogEntryData`].
//! Names are shared strings, so qualified names stay valid across entries without borrowing the name
//! registries of other entries.

use super::ids::*;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// The id of a name within the names of its catalog entry
pub type NameId = u32;

/// A name of a catalog entry
#[derive(Clone, Debug)]
pub struct Name {
    /// The catalog entry that registered the name
    pub entry: CatalogEntryId,
    /// The name id within that entry
    pub id: NameId,
    /// The text
    pub text: Arc<str>,
}

impl Name {
    pub fn text(&self) -> &str {
        &self.text
    }
}

/// A qualified table name
#[derive(Clone, Debug)]
pub struct QualifiedTableName {
    /// The AST node id in the declaring script
    pub ast_node_id: Option<u32>,
    pub database_name: Name,
    pub schema_name: Name,
    pub table_name: Name,
}

/// The lookup key of a qualified name: (database, schema, table)
pub type QualifiedKey = (Arc<str>, Arc<str>, Arc<str>);

impl QualifiedTableName {
    pub fn key(&self) -> QualifiedKey {
        (self.database_name.text.clone(), self.schema_name.text.clone(), self.table_name.text.clone())
    }

    /// `QualifiedTableName::getDebugString`
    pub fn debug_string(&self) -> String {
        debug_string(&self.database_name.text, &self.schema_name.text, &self.table_name.text)
    }
}

fn debug_string(database: &str, schema: &str, name: &str) -> String {
    let mut out = String::new();
    if !database.is_empty() {
        out.push_str(database);
        out.push('.');
        out.push_str(schema);
        out.push('.');
    } else if !schema.is_empty() {
        out.push_str(schema);
        out.push('.');
    }
    out.push_str(name);
    out
}

/// A qualified column name
#[derive(Clone, Debug)]
pub struct QualifiedColumnName {
    /// The AST node id in the declaring script
    pub ast_node_id: Option<u32>,
    pub table_alias: Option<Name>,
    pub column_name: Name,
}

/// A qualified function name
#[derive(Clone, Debug)]
pub struct QualifiedFunctionName {
    /// The AST node id in the declaring script
    pub ast_node_id: Option<u32>,
    pub database_name: Name,
    pub schema_name: Name,
    pub function_name: Name,
}

impl QualifiedFunctionName {
    pub fn key(&self) -> QualifiedKey {
        (self.database_name.text.clone(), self.schema_name.text.clone(), self.function_name.text.clone())
    }

    /// `QualifiedFunctionName::getDebugString`
    pub fn debug_string(&self) -> String {
        debug_string(&self.database_name.text, &self.schema_name.text, &self.function_name.text)
    }
}

/// A table column
#[derive(Clone, Debug)]
pub struct TableColumn {
    pub object_id: QualifiedCatalogObjectId,
    /// The table of the column
    pub table: Option<CatalogTableId>,
    /// The AST node id in the declaring script
    pub ast_node_id: Option<u32>,
    pub column_name: Name,
}

impl TableColumn {
    pub fn column_index(&self) -> u32 {
        self.object_id.unpack_table_column_id().1
    }
}

/// A table declaration
#[derive(Clone, Debug)]
pub struct TableDeclaration {
    pub object_id: QualifiedCatalogObjectId,
    /// The catalog version
    pub catalog_version: CatalogVersion,
    /// The schema of the table
    pub catalog_schema_id: QualifiedCatalogObjectId,
    pub ast_node_id: Option<u32>,
    pub ast_statement_id: Option<u32>,
    pub ast_scope_root: Option<u32>,
    pub table_name: QualifiedTableName,
    pub table_columns: Vec<TableColumn>,
    /// The column indexes by name
    pub table_columns_by_name: HashMap<Arc<str>, usize>,
}

impl TableDeclaration {
    pub fn new(schema: QualifiedCatalogObjectId, table_id: CatalogTableId, table_name: QualifiedTableName) -> Self {
        Self {
            object_id: QualifiedCatalogObjectId::table(table_id),
            catalog_version: 0,
            catalog_schema_id: schema,
            ast_node_id: None,
            ast_statement_id: None,
            ast_scope_root: None,
            table_name,
            table_columns: Vec::new(),
            table_columns_by_name: HashMap::new(),
        }
    }

    pub fn table_id(&self) -> CatalogTableId {
        self.object_id.unpack_table_id()
    }

    /// Find a column by name
    pub fn column_by_name(&self, name: &str) -> Option<&TableColumn> {
        self.table_columns_by_name.get(name).map(|&i| &self.table_columns[i])
    }
}

/// A function parameter
#[derive(Clone, Debug)]
pub struct FunctionParam {
    pub ast_node_id: Option<u32>,
    pub param_name: Name,
    pub param_type: Arc<str>,
}

/// A function declaration
#[derive(Clone, Debug)]
pub struct FunctionDeclaration {
    pub object_id: QualifiedCatalogObjectId,
    pub catalog_schema_id: QualifiedCatalogObjectId,
    pub is_aggregate: bool,
    pub ast_node_id: u32,
    pub ast_statement_id: Option<u32>,
    pub function_name: QualifiedFunctionName,
    pub params: Vec<FunctionParam>,
    pub return_type: Arc<str>,
}

impl FunctionDeclaration {
    pub fn function_id(&self) -> CatalogFunctionId {
        self.object_id.unpack_function_id()
    }
}

/// A referenced database
#[derive(Clone, Debug)]
pub struct DatabaseReference {
    pub object_id: QualifiedCatalogObjectId,
    pub database_name: Arc<str>,
    pub database_alias: Arc<str>,
}

impl DatabaseReference {
    pub fn database_id(&self) -> CatalogDatabaseId {
        self.object_id.unpack_database_id()
    }
}

/// A referenced schema
#[derive(Clone, Debug)]
pub struct SchemaReference {
    pub object_id: QualifiedCatalogObjectId,
    pub database_name: Arc<str>,
    pub schema_name: Arc<str>,
}

impl SchemaReference {
    pub fn database_id(&self) -> CatalogDatabaseId {
        self.object_id.unpack_schema_id().0
    }
    pub fn schema_id(&self) -> CatalogSchemaId {
        self.object_id.unpack_schema_id().1
    }
}

/// The location of a table: catalog entry and index of the declaration
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TableLoc {
    pub entry: CatalogEntryId,
    pub index: u32,
}

impl From<CatalogTableId> for TableLoc {
    fn from(id: CatalogTableId) -> Self {
        Self {
            entry: id.origin,
            index: id.object,
        }
    }
}

/// The location of a table column
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ColumnLoc {
    pub table: TableLoc,
    pub column: u32,
}

/// The declarations of a catalog entry and their indexes
#[derive(Clone, Debug, Default)]
pub struct CatalogEntryData {
    pub catalog_entry_id: CatalogEntryId,
    /// The catalog version when the entry was created
    pub catalog_version: CatalogVersion,
    pub database_references: Vec<DatabaseReference>,
    pub schema_references: Vec<SchemaReference>,
    pub table_declarations: Vec<TableDeclaration>,
    pub function_declarations: Vec<FunctionDeclaration>,
    /// Database references by name
    pub databases_by_name: HashMap<Arc<str>, usize>,
    /// Schema references by (database, schema)
    pub schemas_by_qualified_name: BTreeMap<(Arc<str>, Arc<str>), usize>,
    /// Tables by (database, schema, table)
    pub tables_by_qualified_name: HashMap<QualifiedKey, usize>,
    /// Tables by name, in declaration order
    pub tables_by_unqualified_name: BTreeMap<Arc<str>, Vec<usize>>,
    /// Tables by (schema, database), in declaration order
    pub tables_by_unqualified_schema: BTreeMap<(Arc<str>, Arc<str>), Vec<usize>>,
    /// Table columns by name, in declaration order
    pub table_columns_by_name: BTreeMap<Arc<str>, Vec<ColumnLoc>>,
    /// Functions by (database, schema, function)
    pub functions_by_qualified_name: HashMap<QualifiedKey, usize>,
    /// Functions by name, in declaration order
    pub functions_by_unqualified_name: BTreeMap<Arc<str>, Vec<usize>>,
}

impl CatalogEntryData {
    pub fn new(catalog_entry_id: CatalogEntryId, catalog_version: CatalogVersion) -> Self {
        Self {
            catalog_entry_id,
            catalog_version,
            ..Default::default()
        }
    }

    /// The location of a table of this entry
    pub fn table_loc(&self, index: usize) -> TableLoc {
        TableLoc {
            entry: self.catalog_entry_id,
            index: index as u32,
        }
    }

    /// A table by id (`ResolveTableById`)
    pub fn table_by_id(&self, table_id: CatalogTableId) -> Option<&TableDeclaration> {
        if table_id.origin == self.catalog_entry_id {
            self.table_declarations.get(table_id.object as usize)
        } else {
            None
        }
    }

    /// Resolve a table by name (`CatalogEntry::ResolveTable`)
    pub fn resolve_table(&self, name: &QualifiedTableName, out: &mut Vec<TableLoc>, limit: usize) {
        if let Some(&i) = self.tables_by_qualified_name.get(&name.key()) {
            out.push(self.table_loc(i));
            return;
        }
        if name.database_name.text.is_empty() {
            if name.schema_name.text.is_empty() {
                self.resolve_table_everywhere(&name.table_name.text, out, limit);
            } else {
                self.resolve_table_in_schema(&name.schema_name.text, &name.table_name.text, out, limit);
            }
        }
    }

    /// Resolve a table by schema and name across databases (`ResolveTableInSchema`)
    pub fn resolve_table_in_schema(&self, schema_name: &str, table_name: &str, out: &mut Vec<TableLoc>, limit: usize) {
        let lower = (Arc::<str>::from(schema_name), Arc::<str>::from(""));
        for ((schema, _), tables) in self.tables_by_unqualified_schema.range(lower..) {
            if &**schema != schema_name {
                break;
            }
            for &i in tables {
                if &*self.table_declarations[i].table_name.table_name.text != table_name {
                    continue;
                }
                out.push(self.table_loc(i));
                if out.len() >= limit {
                    return;
                }
            }
        }
    }

    /// Resolve a table by name only (`ResolveTableEverywhere`)
    pub fn resolve_table_everywhere(&self, table_name: &str, out: &mut Vec<TableLoc>, limit: usize) {
        if let Some(tables) = self.tables_by_unqualified_name.get(table_name) {
            for &i in tables {
                out.push(self.table_loc(i));
                if out.len() >= limit {
                    return;
                }
            }
        }
    }

    /// The table columns with a name (`ResolveTableColumns`)
    pub fn resolve_table_columns(&self, column_name: &str, out: &mut Vec<ColumnLoc>) {
        if let Some(columns) = self.table_columns_by_name.get(column_name) {
            out.extend_from_slice(columns);
        }
    }

    /// Index the tables and functions (the first part of `NameResolutionPass::Finish`)
    pub fn index_declarations(&mut self) {
        for (i, table) in self.table_declarations.iter().enumerate() {
            let name = &table.table_name;
            self.tables_by_qualified_name.entry(name.key()).or_insert(i);
            self.tables_by_unqualified_name.entry(name.table_name.text.clone()).or_default().push(i);
            if !name.schema_name.text.is_empty() {
                self.tables_by_unqualified_schema
                    .entry((name.schema_name.text.clone(), name.database_name.text.clone()))
                    .or_default()
                    .push(i);
            }
        }
        for (i, function) in self.function_declarations.iter().enumerate() {
            let name = &function.function_name;
            self.functions_by_qualified_name.entry(name.key()).or_insert(i);
            self.functions_by_unqualified_name.entry(name.function_name.text.clone()).or_default().push(i);
        }
    }

    /// Index the columns of all tables by name
    pub fn index_table_columns(&mut self) {
        for (ti, table) in self.table_declarations.iter().enumerate() {
            for (ci, column) in table.table_columns.iter().enumerate() {
                self.table_columns_by_name.entry(column.column_name.text.clone()).or_default().push(ColumnLoc {
                    table: TableLoc {
                        entry: self.catalog_entry_id,
                        index: ti as u32,
                    },
                    column: ci as u32,
                });
            }
        }
    }
}
