//! Relations created during a shell session, published as a descriptor entry of the catalog
//! (`src/shell/session_relation_catalog.cc`).

use crate::catalog::changes::{derive_catalog_change, qualify_catalog_changes, CatalogChangeOptions, CatalogNameDefaults};
use crate::catalog::{Catalog, CatalogEntryId};
use crate::script::Script;

const SESSION_RELATION_CATALOG_RANK: u32 = 9998;
const SESSION_SCHEMA: &str = "public";

/// The relations of successful DDL statements (`SessionRelationCatalog`)
pub struct SessionRelationCatalog {
    /// The script that analyzes the successful queries
    parser_script: Script,
    /// The descriptor entry with the relations
    entry_id: CatalogEntryId,
    /// How the queries are turned into catalog changes
    options: CatalogChangeOptions,
    /// The names that qualify unqualified relations
    defaults: CatalogNameDefaults,
}

impl SessionRelationCatalog {
    pub fn new(catalog: &Catalog) -> Self {
        Self {
            parser_script: Script::new(catalog),
            entry_id: catalog.allocate_entry_id(),
            // The relations live as long as the session, temporary ones included
            options: CatalogChangeOptions { include_temporary: true },
            defaults: CatalogNameDefaults {
                database_name: String::new(),
                schema_name: SESSION_SCHEMA.to_string(),
            },
        }
    }

    /// Remove the published relations from the catalog (the destructor of the C++ scripts)
    pub fn detach(&self, catalog: &mut Catalog) {
        catalog.drop_script(self.parser_script.catalog_entry_id());
        let _ = catalog.drop_descriptor(self.entry_id);
    }

    /// Track the relation of a query that succeeded (`ApplySuccessfulQuery`). Errors of the local analysis leave
    /// the catalog as it is, the remote engine may accept syntax that the local analyzer does not understand.
    pub fn apply_successful_query(&mut self, query: &str, catalog: &mut Catalog) {
        self.parser_script.replace_text(query);
        if self.parser_script.analyze(catalog, true).is_err() {
            return;
        }
        let Some(analyzed) = self.parser_script.analyzed.clone() else {
            return;
        };
        let parsed = &analyzed.parsed;
        if !parsed.errors.is_empty() || !parsed.scanned.errors.is_empty() || parsed.statements.len() != 1 {
            return;
        }
        if let Some(change) = derive_catalog_change(&analyzed, 0, &self.options) {
            let mut changes = [change];
            qualify_catalog_changes(&mut changes, &self.defaults);
            let _ = catalog.apply_catalog_changes(self.entry_id, SESSION_RELATION_CATALOG_RANK, &changes);
        }
    }
}
