//! The catalog, a port of the C++ `src/catalog.cc`.
//!
//! The catalog publishes catalog entries (analyzed scripts and descriptor pools) atomically and
//! resolves table names across them. Entries are immutable once published and shared through
//! [`CatalogEntryRef`]: an analyzed script keeps the entries it references alive, which replaces the
//! `retained_catalog_dependencies` lease of the C++ core.

pub mod descriptor;
pub mod entry;
pub mod ids;
pub mod names;

pub use descriptor::DescriptorEntry;
pub use entry::*;
pub use ids::*;
pub use names::{IndexedName, NameSearchIndex};

use crate::analyzer::AnalyzedScript;
use crate::error::{Error, Result};
use dashql_buffers::catalog::{
    FlatCatalogEntryT, FlatCatalogT, IndexedFlatDatabaseEntryT, IndexedFlatSchemaEntryT, IndexedFlatTableEntryT,
};
use dashql_buffers::status::StatusCode;
use std::cell::RefCell;
use crate::hash::HashMap;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

/// A published catalog entry
#[derive(Clone, Debug)]
pub enum CatalogEntryRef {
    Script(Arc<AnalyzedScript>),
    Descriptor(Arc<DescriptorEntry>),
}

impl CatalogEntryRef {
    pub fn data(&self) -> &CatalogEntryData {
        match self {
            CatalogEntryRef::Script(s) => &s.entry,
            CatalogEntryRef::Descriptor(d) => &d.entry,
        }
    }

    /// The name search index of the entry, built on first use
    pub fn name_search_index(&self) -> &NameSearchIndex {
        match self {
            CatalogEntryRef::Script(s) => s.name_search_index(),
            CatalogEntryRef::Descriptor(d) => d.name_search_index(),
        }
    }
}

/// A database declared by the catalog
#[derive(Clone, Debug)]
pub struct DatabaseDeclaration {
    pub object_id: QualifiedCatalogObjectId,
    pub database_name: Arc<str>,
    pub database_alias: Arc<str>,
}

/// A schema declared by the catalog
#[derive(Clone, Debug)]
pub struct SchemaDeclaration {
    pub object_id: QualifiedCatalogObjectId,
    pub database_name: Arc<str>,
    pub schema_name: Arc<str>,
}

impl SchemaDeclaration {
    pub fn database_id(&self) -> CatalogDatabaseId {
        self.object_id.unpack_schema_id().0
    }
}

/// A catalog entry that populates a schema
#[derive(Clone, Copy, Debug)]
pub struct SchemaEntryInfo {
    pub catalog_entry_id: CatalogEntryId,
    pub catalog_schema_id: QualifiedCatalogObjectId,
}

/// Canonical ids, reserved during analysis and never reused
#[derive(Debug)]
struct IdReservations {
    database_ids_by_name: HashMap<String, CatalogDatabaseId>,
    schema_ids_by_name: HashMap<(String, String), QualifiedCatalogObjectId>,
    next_database_id: CatalogDatabaseId,
    next_schema_id: CatalogSchemaId,
    next_entry_id: CatalogEntryId,
}

/// The source of unique catalog ids
static NEXT_CATALOG_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// The catalog
#[derive(Debug)]
pub struct Catalog {
    /// A process-unique id, recorded by the scripts analyzed against the catalog
    id: u64,
    /// The version, bumped by every modification
    version: CatalogVersion,
    /// The published entries
    entries: HashMap<CatalogEntryId, CatalogEntryRef>,
    /// The ranks of published scripts
    script_entries: HashMap<CatalogEntryId, (Arc<AnalyzedScript>, Rank)>,
    /// The published descriptor pools
    descriptor_entries: HashMap<CatalogEntryId, Arc<DescriptorEntry>>,
    /// The entries ordered by (rank, id)
    entries_ranked: BTreeSet<(Rank, CatalogEntryId)>,
    /// The entries by (database, schema, rank, id)
    entries_by_qualified_schema: BTreeMap<(Arc<str>, Arc<str>, Rank, CatalogEntryId), SchemaEntryInfo>,
    /// The entries by (schema, rank, id)
    entries_by_schema: BTreeMap<(Arc<str>, Rank, CatalogEntryId), SchemaEntryInfo>,
    /// The databases referenced by entries
    databases: BTreeMap<Arc<str>, Arc<DatabaseDeclaration>>,
    /// The schemas referenced by entries
    schemas: BTreeMap<(Arc<str>, Arc<str>), Arc<SchemaDeclaration>>,
    /// The canonical ids
    ids: RefCell<IdReservations>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self::new()
    }
}

impl Catalog {
    pub fn new() -> Self {
        Self {
            id: NEXT_CATALOG_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            version: 1,
            entries: HashMap::default(),
            script_entries: HashMap::default(),
            descriptor_entries: HashMap::default(),
            entries_ranked: BTreeSet::new(),
            entries_by_qualified_schema: BTreeMap::new(),
            entries_by_schema: BTreeMap::new(),
            databases: BTreeMap::new(),
            schemas: BTreeMap::new(),
            ids: RefCell::new(IdReservations {
                database_ids_by_name: HashMap::default(),
                schema_ids_by_name: HashMap::default(),
                next_database_id: INITIAL_DATABASE_ID,
                next_schema_id: INITIAL_SCHEMA_ID,
                next_entry_id: INITIAL_ENTRY_ID,
            }),
        }
    }

    /// The process-unique id of the catalog
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn version(&self) -> CatalogVersion {
        self.version
    }

    pub fn contains(&self, id: CatalogEntryId) -> bool {
        self.entries.contains_key(&id)
    }

    pub fn entry(&self, id: CatalogEntryId) -> Option<&CatalogEntryRef> {
        self.entries.get(&id)
    }

    /// The entries in ranked order
    pub fn entries_ranked(&self) -> impl Iterator<Item = (Rank, &CatalogEntryRef)> {
        self.entries_ranked.iter().map(|(rank, id)| (*rank, &self.entries[id]))
    }

    pub fn databases(&self) -> &BTreeMap<Arc<str>, Arc<DatabaseDeclaration>> {
        &self.databases
    }

    pub fn schemas(&self) -> &BTreeMap<(Arc<str>, Arc<str>), Arc<SchemaDeclaration>> {
        &self.schemas
    }

    /// The entries by (database, schema, rank, id)
    pub fn entries_by_qualified_schema(&self) -> &BTreeMap<(Arc<str>, Arc<str>, Rank, CatalogEntryId), SchemaEntryInfo> {
        &self.entries_by_qualified_schema
    }

    /// The entries by (schema, rank, id)
    pub fn entries_by_schema(&self) -> &BTreeMap<(Arc<str>, Rank, CatalogEntryId), SchemaEntryInfo> {
        &self.entries_by_schema
    }

    /// Allocate an entry id
    pub fn allocate_entry_id(&self) -> CatalogEntryId {
        let mut ids = self.ids.borrow_mut();
        let id = ids.next_entry_id;
        assert!(id != PROTO_NULL_U32, "catalog entry ID namespace exhausted");
        ids.next_entry_id += 1;
        id
    }

    /// Reserve the canonical id of a database
    pub fn reserve_database_id(&self, database: &str) -> QualifiedCatalogObjectId {
        let mut ids = self.ids.borrow_mut();
        if let Some(&id) = ids.database_ids_by_name.get(database) {
            return QualifiedCatalogObjectId::database(id);
        }
        let id = ids.next_database_id;
        ids.next_database_id += 1;
        ids.database_ids_by_name.insert(database.to_string(), id);
        QualifiedCatalogObjectId::database(id)
    }

    /// Reserve the canonical id of a schema
    pub fn reserve_schema_id(&self, database: &str, schema: &str, db_id: QualifiedCatalogObjectId) -> QualifiedCatalogObjectId {
        let mut ids = self.ids.borrow_mut();
        let key = (database.to_string(), schema.to_string());
        if let Some(&id) = ids.schema_ids_by_name.get(&key) {
            return id;
        }
        let schema_id = ids.next_schema_id;
        ids.next_schema_id += 1;
        let id = QualifiedCatalogObjectId::schema(db_id.unpack_database_id(), schema_id);
        ids.schema_ids_by_name.insert(key, id);
        id
    }

    fn check_canonical_ids(&self, entry: &CatalogEntryData) -> Result<()> {
        let ids = self.ids.borrow();
        for (name, &i) in &entry.databases_by_name {
            let object_id = entry.database_references[i].object_id;
            match ids.database_ids_by_name.get(&**name) {
                Some(&id) if object_id == QualifiedCatalogObjectId::database(id) => {}
                _ => return Err(Error::status(StatusCode::CATALOG_ID_OUT_OF_SYNC)),
            }
        }
        for ((db, schema), &i) in &entry.schemas_by_qualified_name {
            let object_id = entry.schema_references[i].object_id;
            match ids.schema_ids_by_name.get(&(db.to_string(), schema.to_string())) {
                Some(&id) if id == object_id => {}
                _ => return Err(Error::status(StatusCode::CATALOG_ID_OUT_OF_SYNC)),
            }
        }
        Ok(())
    }

    /// Load an analyzed script (`LoadScript`)
    pub fn load_script(&mut self, script: Arc<AnalyzedScript>, rank: Rank) -> Result<()> {
        self.load_scripts(&[(script, rank)])
    }

    /// Atomically add or replace ranked scripts (`LoadScripts`)
    pub fn load_scripts(&mut self, scripts: &[(Arc<AnalyzedScript>, Rank)]) -> Result<()> {
        if scripts.is_empty() {
            return Ok(());
        }
        let mut batch_ids = BTreeSet::new();
        for (script, _) in scripts {
            if script.catalog_id != self.id {
                return Err(Error::status(StatusCode::CATALOG_MISMATCH));
            }
            let id = script.entry.catalog_entry_id;
            if !batch_ids.insert(id) {
                return Err(Error::status(StatusCode::EXTERNAL_ID_COLLISION));
            }
            if self.entries.contains_key(&id) && !self.script_entries.contains_key(&id) {
                return Err(Error::status(StatusCode::EXTERNAL_ID_COLLISION));
            }
            self.check_canonical_ids(&script.entry)?;
        }
        let mut staged = self.script_entries.clone();
        for (script, rank) in scripts {
            staged.insert(script.entry.catalog_entry_id, (script.clone(), *rank));
        }
        let descriptors = self.descriptor_entries.clone();
        self.publish_entries(staged, descriptors)
    }

    /// Build all indexes before committing (`PublishEntries`)
    fn publish_entries(
        &mut self,
        script_entries: HashMap<CatalogEntryId, (Arc<AnalyzedScript>, Rank)>,
        descriptor_entries: HashMap<CatalogEntryId, Arc<DescriptorEntry>>,
    ) -> Result<()> {
        let mut entries = HashMap::default();
        let mut entries_ranked = BTreeSet::new();
        let mut entries_by_qualified_schema = BTreeMap::new();
        let mut entries_by_schema = BTreeMap::new();
        let mut databases: BTreeMap<Arc<str>, Arc<DatabaseDeclaration>> = BTreeMap::new();
        let mut schemas: BTreeMap<(Arc<str>, Arc<str>), Arc<SchemaDeclaration>> = BTreeMap::new();

        let mut stage = |entry: CatalogEntryRef, rank: Rank| -> Result<()> {
            let data = entry.data();
            let entry_id = data.catalog_entry_id;
            entries_ranked.insert((rank, entry_id));
            for (name, &i) in &data.databases_by_name {
                let db = &data.database_references[i];
                if let Some(existing) = databases.get(name) {
                    if existing.object_id != db.object_id {
                        return Err(Error::status(StatusCode::CATALOG_ID_OUT_OF_SYNC));
                    }
                    continue;
                }
                databases.insert(
                    db.database_name.clone(),
                    Arc::new(DatabaseDeclaration {
                        object_id: db.object_id,
                        database_name: db.database_name.clone(),
                        database_alias: db.database_alias.clone(),
                    }),
                );
            }
            for ((db_name, schema_name), &i) in &data.schemas_by_qualified_name {
                let schema = &data.schema_references[i];
                let key = (db_name.clone(), schema_name.clone());
                if let Some(existing) = schemas.get(&key) {
                    if existing.object_id != schema.object_id {
                        return Err(Error::status(StatusCode::CATALOG_ID_OUT_OF_SYNC));
                    }
                    continue;
                }
                if !databases.contains_key(db_name) {
                    return Err(Error::status(StatusCode::CATALOG_ID_OUT_OF_SYNC));
                }
                schemas.insert(
                    key,
                    Arc::new(SchemaDeclaration {
                        object_id: schema.object_id,
                        database_name: db_name.clone(),
                        schema_name: schema.schema_name.clone(),
                    }),
                );
            }
            for ((db_name, schema_name), &i) in &data.schemas_by_qualified_name {
                let info = SchemaEntryInfo {
                    catalog_entry_id: entry_id,
                    catalog_schema_id: data.schema_references[i].object_id,
                };
                entries_by_qualified_schema.insert((db_name.clone(), schema_name.clone(), rank, entry_id), info);
                entries_by_schema.insert((schema_name.clone(), rank, entry_id), info);
            }
            if entries.insert(entry_id, entry.clone()).is_some() {
                return Err(Error::status(StatusCode::EXTERNAL_ID_COLLISION));
            }
            Ok(())
        };
        for (script, rank) in script_entries.values() {
            stage(CatalogEntryRef::Script(script.clone()), *rank)?;
        }
        for descriptor in descriptor_entries.values() {
            stage(CatalogEntryRef::Descriptor(descriptor.clone()), descriptor.rank)?;
        }
        self.script_entries = script_entries;
        self.descriptor_entries = descriptor_entries;
        self.entries = entries;
        self.entries_ranked = entries_ranked;
        self.entries_by_qualified_schema = entries_by_qualified_schema;
        self.entries_by_schema = entries_by_schema;
        self.databases = databases;
        self.schemas = schemas;
        self.version += 1;
        Ok(())
    }

    /// Replace a descriptor pool atomically (`ReplaceDescriptor`)
    pub fn replace_descriptor(&mut self, id: CatalogEntryId, rank: Rank, descriptor: &[u8]) -> Result<()> {
        let next_entry_id = self.ids.borrow().next_entry_id;
        if id < INITIAL_ENTRY_ID
            || id >= next_entry_id
            || (self.entries.contains_key(&id) && !self.descriptor_entries.contains_key(&id))
        {
            return Err(Error::invalid_argument("invalid or colliding receiver catalog entry ID"));
        }
        let entry = DescriptorEntry::new(self, id, rank, descriptor)?;
        let mut staged = self.descriptor_entries.clone();
        staged.insert(id, Arc::new(entry));
        let scripts = self.script_entries.clone();
        self.publish_entries(scripts, staged)
    }

    /// Drop a descriptor pool
    pub fn drop_descriptor(&mut self, id: CatalogEntryId) -> Result<()> {
        if !self.descriptor_entries.contains_key(&id) {
            return Ok(());
        }
        let mut staged = self.descriptor_entries.clone();
        staged.remove(&id);
        let scripts = self.script_entries.clone();
        self.publish_entries(scripts, staged)
    }

    /// Drop a script (`DropScript`)
    pub fn drop_script(&mut self, id: CatalogEntryId) {
        let Some((analyzed, rank)) = self.script_entries.remove(&id) else {
            return;
        };
        for (db_name, schema_name) in analyzed.entry.schemas_by_qualified_name.keys() {
            self.entries_by_qualified_schema.remove(&(db_name.clone(), schema_name.clone(), rank, id));
            self.entries_by_schema.remove(&(schema_name.clone(), rank, id));
        }
        self.entries_ranked.remove(&(rank, id));
        self.entries.remove(&id);
        for (db_name, schema_name) in analyzed.entry.schemas_by_qualified_name.keys() {
            let lower = (db_name.clone(), schema_name.clone(), 0, 0);
            let remaining = self.entries_by_qualified_schema.range(lower..).next();
            match remaining {
                Some(((d, s, _, _), _)) if d == db_name && s == schema_name => {}
                _ => {
                    self.schemas.remove(&(db_name.clone(), schema_name.clone()));
                }
            }
        }
        for name in analyzed.entry.databases_by_name.keys() {
            let referenced = self.entries.values().any(|e| e.data().databases_by_name.contains_key(name));
            if !referenced {
                self.databases.remove(name);
            }
        }
        self.version += 1;
    }

    /// Clear the catalog
    pub fn clear(&mut self) {
        self.entries_by_qualified_schema.clear();
        self.entries_by_schema.clear();
        self.entries_ranked.clear();
        self.entries.clear();
        self.script_entries.clear();
        self.descriptor_entries.clear();
        self.schemas.clear();
        self.databases.clear();
        self.version += 1;
    }

    /// Flatten the catalog (`Catalog::Flatten`).
    ///
    /// Databases, schemas and tables are merged across entries and ordered by name. A table name that
    /// occurs in several entries is taken from the entry with the lowest rank. Names go through a
    /// dictionary, built in rank order, so that JS only decodes the names it renders.
    pub fn flatten(&self) -> FlatCatalogT {
        struct TableNode {
            table_id: CatalogTableId,
            name_id: usize,
            columns_begin: usize,
            column_count: usize,
        }
        struct SchemaNode {
            schema_id: CatalogSchemaId,
            name_id: usize,
            children: BTreeMap<Arc<str>, usize>,
        }
        struct DatabaseNode {
            database_id: CatalogDatabaseId,
            name_id: usize,
            children: BTreeMap<Arc<str>, usize>,
        }

        let mut name_dictionary: Vec<String> = Vec::new();
        let mut name_dictionary_index: HashMap<Arc<str>, usize> = HashMap::default();
        let mut add_name = |name: &Arc<str>| -> usize {
            *name_dictionary_index.entry(name.clone()).or_insert_with(|| {
                name_dictionary.push(name.to_string());
                name_dictionary.len() - 1
            })
        };

        let mut database_nodes: Vec<DatabaseNode> = Vec::new();
        let mut schema_nodes: Vec<SchemaNode> = Vec::new();
        let mut table_nodes: Vec<TableNode> = Vec::new();
        // (column id, name id)
        let mut column_nodes: Vec<(u32, usize)> = Vec::new();
        let mut root: BTreeMap<Arc<str>, usize> = BTreeMap::new();
        let mut database_node_map: HashMap<QualifiedCatalogObjectId, usize> = HashMap::default();
        let mut schema_node_map: HashMap<QualifiedCatalogObjectId, usize> = HashMap::default();

        // Visit entries in rank order, the name dictionary must not depend on the hash implementation
        for (_, entry) in self.entries_ranked() {
            let data = entry.data();
            for db_ref in &data.database_references {
                if database_node_map.contains_key(&db_ref.object_id) {
                    continue;
                }
                let name_id = add_name(&db_ref.database_name);
                database_nodes.push(DatabaseNode {
                    database_id: db_ref.database_id(),
                    name_id,
                    children: BTreeMap::new(),
                });
                database_node_map.insert(db_ref.object_id, database_nodes.len() - 1);
                root.entry(db_ref.database_name.clone()).or_insert(database_nodes.len() - 1);
            }
            for &i in data.schemas_by_qualified_name.values() {
                let schema_ref = &data.schema_references[i];
                if schema_node_map.contains_key(&schema_ref.object_id) {
                    continue;
                }
                let name_id = add_name(&schema_ref.schema_name);
                schema_nodes.push(SchemaNode {
                    schema_id: schema_ref.schema_id(),
                    name_id,
                    children: BTreeMap::new(),
                });
                let schema_node = schema_nodes.len() - 1;
                schema_node_map.insert(schema_ref.object_id, schema_node);
                let db_node = database_node_map[&QualifiedCatalogObjectId::database(schema_ref.database_id())];
                database_nodes[db_node].children.entry(schema_ref.schema_name.clone()).or_insert(schema_node);
            }
        }

        // Tables are not deduplicated among entries, the entry with the lowest rank wins
        for (_, entry) in self.entries_ranked() {
            for table in &entry.data().table_declarations {
                let schema_node = schema_node_map[&table.catalog_schema_id];
                let table_name = &table.table_name.table_name.text;
                if schema_nodes[schema_node].children.contains_key(table_name) {
                    continue;
                }
                let columns_begin = column_nodes.len();
                for (column_id, column) in table.table_columns.iter().enumerate() {
                    let name_id = add_name(&column.column_name.text);
                    column_nodes.push((column_id as u32, name_id));
                }
                let name_id = add_name(table_name);
                table_nodes.push(TableNode {
                    table_id: table.table_id(),
                    name_id,
                    columns_begin,
                    column_count: table.table_columns.len(),
                });
                schema_nodes[schema_node].children.insert(table_name.clone(), table_nodes.len() - 1);
            }
        }

        // (entry index, parent index, object id, name id, child begin, child count)
        let entry = |idx: usize, parent: usize, object_id: u64, name_id: usize, begin: usize, count: usize| {
            FlatCatalogEntryT {
                flat_entry_idx: idx as u32,
                flat_parent_idx: parent as u32,
                catalog_object_id: object_id,
                name_id: name_id as u32,
                child_begin: begin as u32,
                child_count: count as u32,
            }
        };
        let mut databases = Vec::new();
        let mut schemas = Vec::new();
        let mut tables = Vec::new();
        let mut columns = Vec::new();
        let mut databases_by_id = Vec::new();
        let mut schemas_by_id = Vec::new();
        let mut tables_by_id = Vec::new();
        for &db_node in root.values() {
            let db = &database_nodes[db_node];
            let db_idx = databases.len();
            databases.push(entry(db_idx, 0, db.database_id as u64, db.name_id, schemas.len(), db.children.len()));
            databases_by_id.push(IndexedFlatDatabaseEntryT {
                database_id: db.database_id,
                flat_entry_idx: db_idx as u32,
            });
            for &schema_node in db.children.values() {
                let schema = &schema_nodes[schema_node];
                let schema_idx = schemas.len();
                let schema_id = schema.schema_id as u64;
                schemas.push(entry(schema_idx, db_idx, schema_id, schema.name_id, tables.len(), schema.children.len()));
                schemas_by_id.push(IndexedFlatSchemaEntryT {
                    schema_id: schema.schema_id,
                    flat_entry_idx: schema_idx as u32,
                });
                for &table_node in schema.children.values() {
                    let table = &table_nodes[table_node];
                    let table_idx = tables.len();
                    let table_id = table.table_id.pack();
                    let column_count = table.column_count;
                    tables.push(entry(table_idx, schema_idx, table_id, table.name_id, columns.len(), column_count));
                    tables_by_id.push(IndexedFlatTableEntryT {
                        table_id,
                        flat_entry_idx: table_idx as u32,
                    });
                    let table_columns = table.columns_begin..table.columns_begin + table.column_count;
                    for &(column_id, name_id) in &column_nodes[table_columns] {
                        columns.push(entry(columns.len(), table_idx, column_id as u64, name_id, 0, 0));
                    }
                }
            }
        }
        databases_by_id.sort_by_key(|e| e.database_id);
        schemas_by_id.sort_by_key(|e| e.schema_id);
        tables_by_id.sort_by_key(|e| e.table_id);

        let mut out = FlatCatalogT::default();
        out.catalog_version = self.version as u64;
        out.name_dictionary = Some(name_dictionary);
        out.databases = Some(databases);
        out.schemas = Some(schemas);
        out.tables = Some(tables);
        out.columns = Some(columns);
        out.databases_by_id = Some(databases_by_id);
        out.schemas_by_id = Some(schemas_by_id);
        out.tables_by_id = Some(tables_by_id);
        out
    }

    /// A table by id
    pub fn table_by_id(&self, table_id: CatalogTableId) -> Option<&TableDeclaration> {
        self.entries.get(&table_id.origin)?.data().table_by_id(table_id)
    }

    /// A table by location
    pub fn table(&self, loc: TableLoc) -> Option<&TableDeclaration> {
        self.entries.get(&loc.entry)?.data().table_declarations.get(loc.index as usize)
    }

    /// Resolve a table across all entries except `ignore_entry` (`Catalog::ResolveTable`)
    pub fn resolve_table(&self, name: &QualifiedTableName, ignore_entry: CatalogEntryId, out: &mut Vec<TableLoc>, limit: usize) {
        let db = name.database_name.text.clone();
        let schema = name.schema_name.text.clone();
        // Direct lookups of the qualified name
        let lower = (db.clone(), schema.clone(), 0, 0);
        let upper = (db.clone(), schema.clone(), Rank::MAX, CatalogEntryId::MAX);
        let key = name.key();
        for ((_, _, _, candidate), _) in self.entries_by_qualified_schema.range(lower..=upper) {
            if *candidate == ignore_entry {
                continue;
            }
            let entry = self.entries[candidate].data();
            if let Some(&i) = entry.tables_by_qualified_name.get(&key) {
                out.push(entry.table_loc(i));
                if out.len() >= limit {
                    break;
                }
            }
        }
        // A direct hit always wins
        if !out.is_empty() {
            return;
        }
        if !name.database_name.text.is_empty() {
            return;
        }
        if !name.schema_name.text.is_empty() {
            // Table and schema name: search the entries that populate the schema in any database
            let lower = (schema.clone(), 0, 0);
            let upper = (schema.clone(), Rank::MAX, CatalogEntryId::MAX);
            for ((schema_name, _, candidate), _) in self.entries_by_schema.range(lower..=upper) {
                if *candidate == ignore_entry {
                    continue;
                }
                self.entries[candidate].data().resolve_table_in_schema(schema_name, &name.table_name.text, out, limit);
                if out.len() >= limit {
                    break;
                }
            }
        } else {
            // Only the table name: search all entries by rank
            for (_, entry_id) in &self.entries_ranked {
                if *entry_id == ignore_entry {
                    continue;
                }
                self.entries[entry_id].data().resolve_table_everywhere(&name.table_name.text, out, limit);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
}

/// Describe a catalog entry (`CatalogEntry::DescribeEntry`)
fn describe_entry(entry: &CatalogEntryRef) -> dashql_buffers::catalog::CatalogEntryT {
    use dashql_buffers::catalog::{CatalogEntryT, CatalogEntryType, SchemaDescriptorT, SchemaTableColumnT, SchemaTableT};
    let data = entry.data();
    let mut out = CatalogEntryT::default();
    out.catalog_entry_id = data.catalog_entry_id;
    out.catalog_entry_type = CatalogEntryType::DESCRIPTOR_POOL;
    match entry {
        // Scripts are described as one anonymous schema with all tables, with rank 0
        CatalogEntryRef::Script(_) => {
            out.rank = 0;
            let tables = data
                .table_declarations
                .iter()
                .enumerate()
                .map(|(i, table)| {
                    let mut t = SchemaTableT::default();
                    t.table_id = i as u32;
                    t.table_name = Some(table.table_name.table_name.text.to_string());
                    t.columns = Some(
                        table
                            .table_columns
                            .iter()
                            .map(|c| {
                                let mut column = SchemaTableColumnT::default();
                                column.column_name = Some(c.column_name.text.to_string());
                                column
                            })
                            .collect(),
                    );
                    t
                })
                .collect();
            let mut schema = SchemaDescriptorT::default();
            schema.tables = Some(tables);
            out.schemas = Some(vec![schema]);
        }
        CatalogEntryRef::Descriptor(descriptor) => {
            out.rank = descriptor.rank;
            let schemas = data
                .schemas_by_qualified_name
                .iter()
                .map(|((db, name), &i)| {
                    let schema_id = data.schema_references[i].object_id;
                    let tables = data
                        .table_declarations
                        .iter()
                        .filter(|t| t.catalog_schema_id == schema_id)
                        .map(|table| {
                            let mut t = SchemaTableT::default();
                            t.table_id = table.table_id().object;
                            t.table_name = Some(table.table_name.table_name.text.to_string());
                            t.columns = Some(
                                table
                                    .table_columns
                                    .iter()
                                    .map(|c| {
                                        let mut column = SchemaTableColumnT::default();
                                        column.column_name = Some(c.column_name.text.to_string());
                                        column.ordinal_position = c.column_index();
                                        column
                                    })
                                    .collect(),
                            );
                            t
                        })
                        .collect();
                    let mut schema = SchemaDescriptorT::default();
                    schema.database_name = Some(db.to_string());
                    schema.schema_name = Some(name.to_string());
                    schema.tables = Some(tables);
                    schema
                })
                .collect();
            out.schemas = Some(schemas);
        }
    }
    out
}

impl Catalog {
    /// Describe all entries in rank order (`DescribeEntries`)
    pub fn describe_entries(&self) -> dashql_buffers::catalog::CatalogEntriesT {
        let mut out = dashql_buffers::catalog::CatalogEntriesT::default();
        out.entries = Some(self.entries_ranked().map(|(_, e)| describe_entry(e)).collect());
        out
    }

    /// Describe one entry (`DescribeEntriesOf`), None if the entry is unknown
    pub fn describe_entries_of(&self, id: CatalogEntryId) -> Option<dashql_buffers::catalog::CatalogEntriesT> {
        let entry = self.entries.get(&id)?;
        let mut out = dashql_buffers::catalog::CatalogEntriesT::default();
        out.entries = Some(vec![describe_entry(entry)]);
        Some(out)
    }

    /// The statistics of the catalog content (`GetStatistics`)
    pub fn statistics(&self) -> dashql_buffers::catalog::CatalogStatisticsT {
        let mut content = dashql_buffers::catalog::CatalogContentStatisticsT::default();
        content.database_count = self.databases.len() as u32;
        content.schema_count = self.schemas.len() as u32;
        content.table_count = self.entries.values().map(|e| e.data().table_declarations.len() as u32).sum();
        content.table_column_count = self
            .entries
            .values()
            .flat_map(|e| e.data().table_declarations.iter())
            .map(|t| t.table_columns.len() as u32)
            .sum();
        let mut out = dashql_buffers::catalog::CatalogStatisticsT::default();
        out.content = Some(content);
        out
    }
}
