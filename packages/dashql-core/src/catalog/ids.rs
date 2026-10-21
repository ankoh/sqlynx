//! Catalog object ids (`include/dashql/catalog_object.h`, `include/dashql/external.h`).

/// The id of a catalog entry (a script or a descriptor pool)
pub type CatalogEntryId = u32;
/// A database id
pub type CatalogDatabaseId = u32;
/// A schema id
pub type CatalogSchemaId = u32;
/// The catalog version, bumped by every modification
pub type CatalogVersion = u32;
/// The rank of a catalog entry
pub type Rank = u32;

/// The null value of u32 fields in FlatBuffers
pub const PROTO_NULL_U32: u32 = u32::MAX;
/// The first database id
pub const INITIAL_DATABASE_ID: CatalogDatabaseId = 1 << 8;
/// The first schema id
pub const INITIAL_SCHEMA_ID: CatalogSchemaId = 1 << 16;
/// The first entry id
pub const INITIAL_ENTRY_ID: CatalogEntryId = 1;

/// An object id annotated with the catalog entry it belongs to (`ExternalObjectID`)
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ExternalObjectId {
    /// The catalog entry
    pub origin: CatalogEntryId,
    /// The index within the entry
    pub object: u32,
}

impl Default for ExternalObjectId {
    fn default() -> Self {
        Self { origin: u32::MAX, object: u32::MAX }
    }
}

impl ExternalObjectId {
    pub const fn new(origin: CatalogEntryId, object: u32) -> Self {
        Self { origin, object }
    }

    /// Is a null id?
    pub fn is_null(&self) -> bool {
        self.object == u32::MAX
    }

    pub fn pack(&self) -> u64 {
        ((self.origin as u64) << 32) | self.object as u64
    }

    pub fn unpack(packed: u64) -> Self {
        Self {
            origin: (packed >> 32) as u32,
            object: packed as u32,
        }
    }
}

/// A table id
pub type CatalogTableId = ExternalObjectId;
/// A function id
pub type CatalogFunctionId = ExternalObjectId;

/// The type of a catalog object, numbered like `CompletionCandidateObjectType`
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum CatalogObjectType {
    #[default]
    Deferred = 0,
    DatabaseReference = 1,
    SchemaReference = 2,
    TableDeclaration = 3,
    ColumnDeclaration = 4,
    FunctionDeclaration = 5,
}

/// The id of a catalog object (`QualifiedCatalogObjectID`), ordered by type, part 0, part 1
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct QualifiedCatalogObjectId {
    /// The type of the object
    object_type: CatalogObjectType,
    /// The database id, or the packed table or function id
    part0: u64,
    /// The schema id or the column index, 0 for other types
    part1: u32,
}

impl QualifiedCatalogObjectId {
    pub const fn deferred() -> Self {
        Self {
            object_type: CatalogObjectType::Deferred,
            part0: 0,
            part1: 0,
        }
    }
    pub const fn database(database_id: CatalogDatabaseId) -> Self {
        Self {
            object_type: CatalogObjectType::DatabaseReference,
            part0: database_id as u64,
            part1: 0,
        }
    }
    pub const fn schema(database_id: CatalogDatabaseId, schema_id: CatalogSchemaId) -> Self {
        Self {
            object_type: CatalogObjectType::SchemaReference,
            part0: database_id as u64,
            part1: schema_id,
        }
    }
    pub fn table(table_id: CatalogTableId) -> Self {
        Self {
            object_type: CatalogObjectType::TableDeclaration,
            part0: table_id.pack(),
            part1: 0,
        }
    }
    pub fn table_column(table_id: CatalogTableId, column_id: u32) -> Self {
        Self {
            object_type: CatalogObjectType::ColumnDeclaration,
            part0: table_id.pack(),
            part1: column_id,
        }
    }
    pub fn function(function_id: CatalogFunctionId) -> Self {
        Self {
            object_type: CatalogObjectType::FunctionDeclaration,
            part0: function_id.pack(),
            part1: 0,
        }
    }

    pub fn object_type(&self) -> CatalogObjectType {
        self.object_type
    }
    pub fn unpack_database_id(&self) -> CatalogDatabaseId {
        debug_assert_eq!(self.object_type, CatalogObjectType::DatabaseReference);
        self.part0 as u32
    }
    pub fn unpack_schema_id(&self) -> (CatalogDatabaseId, CatalogSchemaId) {
        debug_assert_eq!(self.object_type, CatalogObjectType::SchemaReference);
        (self.part0 as u32, self.part1)
    }
    pub fn unpack_table_id(&self) -> CatalogTableId {
        debug_assert_eq!(self.object_type, CatalogObjectType::TableDeclaration);
        ExternalObjectId::unpack(self.part0)
    }
    pub fn unpack_table_column_id(&self) -> (CatalogTableId, u32) {
        debug_assert_eq!(self.object_type, CatalogObjectType::ColumnDeclaration);
        (ExternalObjectId::unpack(self.part0), self.part1)
    }
    pub fn unpack_function_id(&self) -> CatalogFunctionId {
        debug_assert_eq!(self.object_type, CatalogObjectType::FunctionDeclaration);
        ExternalObjectId::unpack(self.part0)
    }
}
