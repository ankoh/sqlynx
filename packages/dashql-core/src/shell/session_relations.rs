//! Relations created during a shell session, published as a catalog script
//! (`src/shell/session_relation_catalog.cc`).

use crate::catalog::Catalog;
use crate::pack::pack_parsed_statement;
use crate::script::Script;
use dashql_buffers::parser::StatementType;
use std::collections::BTreeMap;

const SESSION_RELATION_CATALOG_RANK: u32 = 9998;
const SESSION_SCHEMA: &str = "public";
const CATALOG_HEADER: &str = "-- Relations created during this shell session.";

fn quote_identifier(identifier: &str, out: &mut String) {
    out.push('"');
    for c in identifier.chars() {
        out.push(c);
        if c == '"' {
            out.push('"');
        }
    }
    out.push('"');
}

/// A relation created during the session
struct Relation {
    /// The database name, empty for the default database
    database_name: String,
    /// The schema name, `public` if not given
    schema_name: String,
    /// The relation name
    relation_name: String,
    /// The column names
    columns: Vec<String>,
}

/// The relations of successful DDL statements (`SessionRelationCatalog`)
pub struct SessionRelationCatalog {
    /// The script that analyzes the successful queries
    parser_script: Script,
    /// The script with the CREATE TABLE statements of the relations, loaded into the catalog
    catalog_script: Script,
    /// The relations, keyed by database, schema and relation name
    relations: BTreeMap<(String, String, String), Relation>,
}

impl SessionRelationCatalog {
    pub fn new(catalog: &Catalog) -> Self {
        let parser_script = Script::new(catalog);
        let mut catalog_script = Script::new(catalog);
        catalog_script.replace_text(CATALOG_HEADER);
        Self {
            parser_script,
            catalog_script,
            relations: BTreeMap::new(),
        }
    }

    /// Remove the published relations from the catalog (the destructor of the C++ scripts)
    pub fn detach(&self, catalog: &mut Catalog) {
        catalog.drop_script(self.parser_script.catalog_entry_id());
        catalog.drop_script(self.catalog_script.catalog_entry_id());
    }

    /// Track the relation of a query that succeeded (`ApplySuccessfulQuery`). Errors of the local analysis leave
    /// the catalog as it is, the remote engine may accept syntax that the local analyzer does not understand.
    pub fn apply_successful_query(&mut self, query: &str, catalog: &mut Catalog) {
        self.parser_script.replace_text(query);
        if self.parser_script.analyze(catalog, true).is_err() {
            return;
        }
        let (Some(parsed), Some(analyzed)) = (self.parser_script.parsed.clone(), self.parser_script.analyzed.clone()) else {
            return;
        };
        if !parsed.errors.is_empty() || !parsed.scanned.errors.is_empty() || parsed.statements.len() != 1 {
            return;
        }
        let statement_type = parsed.statements[0].statement_type;
        match statement_type {
            StatementType::CREATE_TABLE
            | StatementType::CREATE_TABLE_AS
            | StatementType::CREATE_VIEW
            | StatementType::SELECT_INTO
            | StatementType::DROP_TABLE
            | StatementType::DROP_VIEW => {}
            _ => return,
        }
        let statement = pack_parsed_statement(&parsed, 0);
        let Some(target) = statement.target.map(|t| *t) else {
            return;
        };
        let relation_name = target.relation_name.unwrap_or_default();
        if relation_name.is_empty() {
            return;
        }
        let database_name = target.database_name.unwrap_or_default();
        let schema_name = match target.schema_name {
            Some(schema) if !schema.is_empty() => schema,
            _ => SESSION_SCHEMA.to_string(),
        };
        let key = (database_name.clone(), schema_name.clone(), relation_name.clone());
        if statement_type == StatementType::DROP_TABLE || statement_type == StatementType::DROP_VIEW {
            self.relations.remove(&key);
        } else {
            let mut relation = Relation {
                database_name,
                schema_name,
                relation_name,
                columns: Vec::new(),
            };
            for table in &analyzed.entry.table_declarations {
                let schema = if table.table_name.schema_name.text.is_empty() { SESSION_SCHEMA } else { &table.table_name.schema_name.text };
                if *table.table_name.database_name.text != *relation.database_name
                    || schema != relation.schema_name
                    || *table.table_name.table_name.text != *relation.relation_name
                {
                    continue;
                }
                relation.columns = table.table_columns.iter().map(|c| c.column_name.text.to_string()).collect();
                break;
            }
            self.relations.insert(key, relation);
        }
        self.reload_catalog_script(catalog);
    }

    fn reload_catalog_script(&mut self, catalog: &mut Catalog) {
        self.catalog_script.replace_text(&self.render_catalog());
        if self.catalog_script.analyze(catalog, true).is_err() {
            return;
        }
        catalog.drop_script(self.catalog_script.catalog_entry_id());
        if let Some(analyzed) = self.catalog_script.analyzed.clone() {
            let _ = catalog.load_script(analyzed, SESSION_RELATION_CATALOG_RANK);
        }
    }

    fn render_catalog(&self) -> String {
        let mut output = String::from(CATALOG_HEADER);
        for relation in self.relations.values() {
            output.push_str("\n\nCREATE TABLE ");
            if !relation.database_name.is_empty() {
                quote_identifier(&relation.database_name, &mut output);
                output.push('.');
            }
            quote_identifier(&relation.schema_name, &mut output);
            output.push('.');
            quote_identifier(&relation.relation_name, &mut output);
            output.push_str(" (\n");
            for (i, column) in relation.columns.iter().enumerate() {
                if i != 0 {
                    output.push_str(",\n");
                }
                output.push_str("    ");
                quote_identifier(column, &mut output);
                output.push_str(" VARCHAR");
            }
            output.push_str("\n);");
        }
        output
    }
}
