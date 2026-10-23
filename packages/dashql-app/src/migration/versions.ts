/// The version of the storage of the app (the OPFS root), stored as `storageVersion` in the manifest.
/// A manifest without a version is at version 1. `STORAGE_MIGRATION_STEPS` ends with this version.
export const STORAGE_VERSION = 4;

/// The format version of the session metadata, stored as `formatVersion` in `dashql-session.json`.
/// `SESSION_MIGRATION_STEPS` ends with this version.
export const SESSION_FORMAT_VERSION = 7;

/// Session folders up to this format version hold a copy of the catalog of their default connection,
/// the next format version removes it.
export const SESSION_CATALOG_COPY_FORMAT_VERSION = 6;
