//! Catalog entries backed by descriptor bytes, a port of `src/catalog_descriptor.cc`.

use super::entry::*;
use super::ids::*;
use super::Catalog;
use crate::error::{Error, Result};
use dashql_buffers::analyzer::NameTag;
use dashql_buffers::catalog::CatalogDescriptor;
use std::collections::BTreeSet;
use std::sync::Arc;

/// A name of a descriptor entry
#[derive(Clone, Debug)]
pub struct DescriptorName {
    pub text: Arc<str>,
    /// The name tags
    pub tags: u8,
    pub occurrences: u32,
}

/// Declarations imported from verified `CatalogDescriptor` bytes
#[derive(Debug)]
pub struct DescriptorEntry {
    pub entry: CatalogEntryData,
    pub rank: Rank,
    /// The names in registration order
    pub names: Vec<DescriptorName>,
    /// The descriptor bytes
    pub bytes: Vec<u8>,
}

fn invalid(message: &str) -> Error {
    Error::invalid_argument(message)
}

/// Validate a name or type text
fn validate_text(text: Option<&str>, required: bool) -> Result<()> {
    let value = text.unwrap_or("");
    if (required && value.is_empty()) || value.contains('\0') {
        return Err(invalid("invalid catalog descriptor name or type"));
    }
    Ok(())
}

/// Verify descriptor bytes (`ValidateDescriptor`)
pub fn validate_descriptor(data: &[u8]) -> Result<CatalogDescriptor<'_>> {
    if data.is_empty() {
        return Err(invalid("invalid CatalogDescriptor FlatBuffer"));
    }
    let descriptor =
        flatbuffers::root::<CatalogDescriptor>(data).map_err(|_| invalid("invalid CatalogDescriptor FlatBuffer"))?;
    let mut table_names = BTreeSet::new();
    if let Some(tables) = descriptor.tables() {
        for table in tables {
            let name = table.table_name().ok_or_else(|| invalid("missing descriptor table name"))?;
            validate_text(name.database_name(), false)?;
            validate_text(name.schema_name(), false)?;
            validate_text(name.table_name(), true)?;
            let key = (
                name.database_name().unwrap_or(""),
                name.schema_name().unwrap_or(""),
                name.table_name().unwrap_or(""),
            );
            if !table_names.insert(key) {
                return Err(invalid("duplicate descriptor table name"));
            }
            let mut columns = BTreeSet::new();
            if let Some(values) = table.table_columns() {
                for column in values {
                    validate_text(column.column_name(), true)?;
                    if !columns.insert(column.column_name().unwrap_or("")) {
                        return Err(invalid("duplicate descriptor column name"));
                    }
                }
            }
        }
    }
    if let Some(functions) = descriptor.function_declarations() {
        for function in functions {
            let name = function.function_name().ok_or_else(|| invalid("missing descriptor function name"))?;
            validate_text(name.database_name(), false)?;
            validate_text(name.schema_name(), false)?;
            validate_text(name.function_name(), true)?;
            validate_text(function.return_type(), true)?;
            let mut params = BTreeSet::new();
            if let Some(values) = function.params() {
                for param in values {
                    validate_text(param.param_name(), false)?;
                    validate_text(param.param_type(), true)?;
                    let name = param.param_name().unwrap_or("");
                    if !name.is_empty() && !params.insert(name) {
                        return Err(invalid("duplicate descriptor parameter name"));
                    }
                }
            }
        }
    }
    Ok(descriptor)
}

impl DescriptorEntry {
    /// Import descriptor bytes (`DescriptorEntry::DescriptorEntry`)
    pub fn new(catalog: &Catalog, id: CatalogEntryId, rank: Rank, bytes: &[u8]) -> Result<Self> {
        let descriptor = validate_descriptor(bytes)?;
        let mut out = DescriptorEntry {
            entry: CatalogEntryData::new(id, catalog.version()),
            rank,
            names: Vec::new(),
            bytes: bytes.to_vec(),
        };
        // The new entry is published with the next catalog version, as are its tables
        out.entry.catalog_version = catalog.version() + 1;
        let table_version = catalog.version() + 1;
        let mut names_by_text = std::collections::HashMap::<Arc<str>, NameId>::new();
        let mut register = |out: &mut DescriptorEntry, text: &str, tag: NameTag| -> Name {
            let id = match names_by_text.get(text) {
                Some(&id) => {
                    let name = &mut out.names[id as usize];
                    name.tags |= tag.0;
                    name.occurrences += 1;
                    id
                }
                None => {
                    let id = out.names.len() as NameId;
                    let text: Arc<str> = Arc::from(text);
                    out.names.push(DescriptorName {
                        text: text.clone(),
                        tags: tag.0,
                        occurrences: 1,
                    });
                    names_by_text.insert(text, id);
                    id
                }
            };
            Name {
                entry: out.entry.catalog_entry_id,
                id,
                text: out.names[id as usize].text.clone(),
            }
        };
        let register_schema = |out: &mut DescriptorEntry, database: &Name, schema: &Name| -> QualifiedCatalogObjectId {
            let entry = &mut out.entry;
            let db_id = match entry.databases_by_name.get(&database.text) {
                Some(&i) => entry.database_references[i].object_id,
                None => {
                    let db_id = catalog.reserve_database_id(&database.text);
                    entry.database_references.push(DatabaseReference {
                        object_id: db_id,
                        database_name: database.text.clone(),
                        database_alias: Arc::from(""),
                    });
                    entry.databases_by_name.insert(database.text.clone(), entry.database_references.len() - 1);
                    db_id
                }
            };
            let key = (database.text.clone(), schema.text.clone());
            if let Some(&i) = entry.schemas_by_qualified_name.get(&key) {
                return entry.schema_references[i].object_id;
            }
            let schema_id = catalog.reserve_schema_id(&database.text, &schema.text, db_id);
            entry.schema_references.push(SchemaReference {
                object_id: schema_id,
                database_name: database.text.clone(),
                schema_name: schema.text.clone(),
            });
            entry.schemas_by_qualified_name.insert(key, entry.schema_references.len() - 1);
            schema_id
        };

        if let Some(tables) = descriptor.tables() {
            for source in tables {
                let name = source.table_name().unwrap();
                let db = register(&mut out, name.database_name().unwrap_or(""), NameTag::DATABASE_NAME);
                let schema = register(&mut out, name.schema_name().unwrap_or(""), NameTag::SCHEMA_NAME);
                let table_name = register(&mut out, name.table_name().unwrap_or(""), NameTag::TABLE_NAME);
                let schema_id = register_schema(&mut out, &db, &schema);
                let table_index = out.entry.table_declarations.len();
                let table_id = CatalogTableId::new(id, table_index as u32);
                let mut table = TableDeclaration::new(
                    schema_id,
                    table_id,
                    QualifiedTableName {
                        ast_node_id: None,
                        database_name: db.clone(),
                        schema_name: schema.clone(),
                        table_name: table_name.clone(),
                    },
                );
                table.catalog_version = table_version;
                if let Some(columns) = source.table_columns() {
                    for source_column in columns {
                        let column_name =
                            register(&mut out, source_column.column_name().unwrap_or(""), NameTag::COLUMN_NAME);
                        let ordinal = table.table_columns.len() as u32;
                        table.table_columns_by_name.entry(column_name.text.clone()).or_insert(ordinal as usize);
                        out.entry.table_columns_by_name.entry(column_name.text.clone()).or_default().push(ColumnLoc {
                            table: TableLoc {
                                entry: id,
                                index: table_index as u32,
                            },
                            column: ordinal,
                        });
                        table.table_columns.push(TableColumn {
                            object_id: QualifiedCatalogObjectId::table_column(table_id, ordinal),
                            table: Some(table_id),
                            ast_node_id: None,
                            column_name,
                        });
                    }
                }
                let entry = &mut out.entry;
                entry.tables_by_qualified_name.entry(table.table_name.key()).or_insert(table_index);
                entry.tables_by_unqualified_name.entry(table_name.text.clone()).or_default().push(table_index);
                entry
                    .tables_by_unqualified_schema
                    .entry((schema.text.clone(), db.text.clone()))
                    .or_default()
                    .push(table_index);
                entry.table_declarations.push(table);
            }
        }
        if let Some(functions) = descriptor.function_declarations() {
            for source in functions {
                let name = source.function_name().unwrap();
                let db = register(&mut out, name.database_name().unwrap_or(""), NameTag::DATABASE_NAME);
                let schema = register(&mut out, name.schema_name().unwrap_or(""), NameTag::SCHEMA_NAME);
                let function_name = register(&mut out, name.function_name().unwrap_or(""), NameTag::FUNCTION_NAME);
                let schema_id = register_schema(&mut out, &db, &schema);
                let function_index = out.entry.function_declarations.len();
                let function_id = CatalogFunctionId::new(id, function_index as u32);
                let mut params = Vec::new();
                if let Some(values) = source.params() {
                    for param in values {
                        let param_name = register(&mut out, param.param_name().unwrap_or(""), NameTag::NONE);
                        params.push(FunctionParam {
                            ast_node_id: None,
                            param_name,
                            param_type: Arc::from(param.param_type().unwrap_or("")),
                        });
                    }
                }
                let function = FunctionDeclaration {
                    object_id: QualifiedCatalogObjectId::function(function_id),
                    catalog_schema_id: schema_id,
                    is_aggregate: source.is_aggregate(),
                    ast_node_id: u32::MAX,
                    ast_statement_id: None,
                    function_name: QualifiedFunctionName {
                        ast_node_id: None,
                        database_name: db,
                        schema_name: schema,
                        function_name,
                    },
                    params,
                    return_type: Arc::from(source.return_type().unwrap_or("")),
                };
                let entry = &mut out.entry;
                entry.functions_by_qualified_name.entry(function.function_name.key()).or_insert(function_index);
                entry
                    .functions_by_unqualified_name
                    .entry(function.function_name.function_name.text.clone())
                    .or_default()
                    .push(function_index);
                entry.function_declarations.push(function);
            }
        }
        Ok(out)
    }
}
