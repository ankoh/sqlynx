//! The declarations of a catalog entry (`CatalogEntry` in `include/dashql/catalog.h`).
//!
//! Analyzed scripts and descriptor pools both expose their declarations through [`CatalogEntryData`].
//! Names are shared strings, so qualified names stay valid across entries without borrowing the name
//! registries of other entries.

use super::ids::*;
use crate::hash::HashMap;
use std::collections::BTreeMap;
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
    /// The database name, empty when not qualified
    pub database_name: Name,
    /// The schema name, empty when not qualified
    pub schema_name: Name,
    /// The table name
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
    /// The table alias qualifying the column, if any
    pub table_alias: Option<Name>,
    /// The column name
    pub column_name: Name,
}

/// A qualified function name
#[derive(Clone, Debug)]
pub struct QualifiedFunctionName {
    /// The AST node id in the declaring script
    pub ast_node_id: Option<u32>,
    /// The database name, empty when not qualified
    pub database_name: Name,
    /// The schema name, empty when not qualified
    pub schema_name: Name,
    /// The function name
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
    /// The qualified object id, packs the table id and the column index
    pub object_id: QualifiedCatalogObjectId,
    /// The table of the column
    pub table: Option<CatalogTableId>,
    /// The AST node id in the declaring script
    pub ast_node_id: Option<u32>,
    /// The column name
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
    /// The qualified object id of the table
    pub object_id: QualifiedCatalogObjectId,
    /// The catalog version
    pub catalog_version: CatalogVersion,
    /// The schema of the table
    pub catalog_schema_id: QualifiedCatalogObjectId,
    /// The AST node id of the declaration in the declaring script
    pub ast_node_id: Option<u32>,
    /// The id of the declaring statement
    pub ast_statement_id: Option<u32>,
    /// The root node of the name scope of the defining SELECT, for derived tables
    pub ast_scope_root: Option<u32>,
    /// The qualified table name
    pub table_name: QualifiedTableName,
    /// The columns, in declaration order
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
            table_columns_by_name: HashMap::default(),
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
    /// The AST node id in the declaring script
    pub ast_node_id: Option<u32>,
    /// The parameter name
    pub param_name: Name,
    /// The parameter type as written, empty when not specified
    pub param_type: Arc<str>,
}

/// A function declaration
#[derive(Clone, Debug)]
pub struct FunctionDeclaration {
    /// The qualified object id of the function
    pub object_id: QualifiedCatalogObjectId,
    /// The schema of the function
    pub catalog_schema_id: QualifiedCatalogObjectId,
    /// Whether the function is an aggregate function
    pub is_aggregate: bool,
    /// The AST node id in the declaring script, `u32::MAX` for descriptor functions
    pub ast_node_id: u32,
    /// The id of the declaring statement
    pub ast_statement_id: Option<u32>,
    /// The qualified function name
    pub function_name: QualifiedFunctionName,
    /// The parameters, in declaration order
    pub params: Vec<FunctionParam>,
    /// The return type as written, empty when not specified
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
    /// The qualified object id of the database
    pub object_id: QualifiedCatalogObjectId,
    /// The database name
    pub database_name: Arc<str>,
    /// The database alias, empty when not aliased
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
    /// The qualified object id, packs the database and schema ids
    pub object_id: QualifiedCatalogObjectId,
    /// The database name
    pub database_name: Arc<str>,
    /// The schema name
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
    /// The catalog entry that declares the table
    pub entry: CatalogEntryId,
    /// The index in the table declarations of the entry
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
    /// The table of the column
    pub table: TableLoc,
    /// The index in the columns of the table
    pub column: u32,
}

/// The location of an object in the vectors of a catalog entry
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ObjectLoc {
    /// The catalog entry that declares the object
    pub entry: CatalogEntryId,
    /// The index in the declaration vector of the object kind
    pub index: u32,
}

/// A catalog object (`CatalogObject`): a declaration of a catalog entry
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CatalogObjectRef {
    Database(ObjectLoc),
    Schema(ObjectLoc),
    Table(TableLoc),
    Column(ColumnLoc),
    Function(ObjectLoc),
}

impl CatalogObjectRef {
    pub fn object_type(&self) -> CatalogObjectType {
        match self {
            CatalogObjectRef::Database(_) => CatalogObjectType::DatabaseReference,
            CatalogObjectRef::Schema(_) => CatalogObjectType::SchemaReference,
            CatalogObjectRef::Table(_) => CatalogObjectType::TableDeclaration,
            CatalogObjectRef::Column(_) => CatalogObjectType::ColumnDeclaration,
            CatalogObjectRef::Function(_) => CatalogObjectType::FunctionDeclaration,
        }
    }

    /// The entry that declares the object
    pub fn entry(&self) -> CatalogEntryId {
        match self {
            CatalogObjectRef::Database(l) | CatalogObjectRef::Schema(l) | CatalogObjectRef::Function(l) => l.entry,
            CatalogObjectRef::Table(t) => t.entry,
            CatalogObjectRef::Column(c) => c.table.entry,
        }
    }
}

/// The declarations of a catalog entry and their indexes
#[derive(Clone, Debug, Default)]
pub struct CatalogEntryData {
    /// The id of the catalog entry
    pub catalog_entry_id: CatalogEntryId,
    /// The catalog version when the entry was created
    pub catalog_version: CatalogVersion,
    /// The databases the entry references, in registration order
    pub database_references: Vec<DatabaseReference>,
    /// The schemas the entry references, in registration order
    pub schema_references: Vec<SchemaReference>,
    /// The tables the entry declares, in declaration order
    pub table_declarations: Vec<TableDeclaration>,
    /// The functions the entry declares, in declaration order
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

    /// The id of an object of this entry
    pub fn object_id(&self, object: CatalogObjectRef) -> QualifiedCatalogObjectId {
        match object {
            CatalogObjectRef::Database(l) => self.database_references[l.index as usize].object_id,
            CatalogObjectRef::Schema(l) => self.schema_references[l.index as usize].object_id,
            CatalogObjectRef::Table(t) => self.table_declarations[t.index as usize].object_id,
            CatalogObjectRef::Column(c) => self.table_declarations[c.table.index as usize].table_columns[c.column as usize].object_id,
            CatalogObjectRef::Function(l) => self.function_declarations[l.index as usize].object_id,
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
