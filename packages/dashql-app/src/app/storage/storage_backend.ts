import type * as app_manifest from '@ankoh/dashql-jsonschema/app_manifest.js';
import type * as app_session from '@ankoh/dashql-jsonschema/app_session.js';

import type { CacheFileStat } from './query_result_cache_eviction.js';
import type { CachedQueryResult } from '../../query/query_result_cache.js';
import { HYPER_OPFS_ROOT } from '../../platform/hyperdb/hyperdb_opfs.js';
export type { CachedQueryResult } from '../../query/query_result_cache.js';

// Storage file and folder naming conventions
export const STORAGE_MANIFEST_FILE = 'dashql-manifest.json';
export const STORAGE_SESSIONS_FOLDER = 'sessions';
export const STORAGE_SESSION_FILE = 'dashql-session.json';
export const STORAGE_SCRIPTS_FOLDER = 'scripts';
export const STORAGE_ATTACHMENTS_FOLDER = 'attachments';
export const STORAGE_CACHE_FOLDER = 'cache';
export const STORAGE_CACHE_EXTENSION = '.arrow';
/// Suffix of the empty "last access" marker that sits beside each cached `.arrow` file, e.g.
/// `<hash>.arrow.last_access`. Its own mtime is the entry's last-access time and is bumped (by
/// rewriting the empty file) on every cache hit — this is how the FIFO-by-write-time cache is turned
/// into an LRU without rewriting the (potentially large) payload. The marker is advisory: the
/// `.arrow` files are authoritative, so a missing marker just falls back to the payload's own mtime.
export const STORAGE_CACHE_ACCESS_SUFFIX = '.last_access';
export const STORAGE_SHELL_FOLDER = 'shell';
/// The folder that holds the files of the connections, e.g. `connections/<uuid>/…`
export const STORAGE_CONNECTIONS_FOLDER = 'connections';
/// The extract of the Hyper log of a connection, e.g. `connections/<uuid>/logs.hyper`.
/// It is deleted with the files of the connection, and it is not part of session bundles.
export const STORAGE_CONNECTION_LOGS_FILE = 'logs.hyper';

/// The Hyper path of the log extract of a connection
export function connectionLogsDatabasePath(connectionId: string): string {
    return `${HYPER_OPFS_ROOT}/${STORAGE_CONNECTIONS_FOLDER}/${connectionId}/${STORAGE_CONNECTION_LOGS_FILE}`;
}

/// The relations of the catalog, as the last catalog refresh described them
export const STORAGE_CATALOG_RELATIONS = 'dashql-catalog-relations.sql';
/// The functions of the catalog
export const STORAGE_CATALOG_FUNCTIONS = 'dashql-catalog-functions.sql';
/// The catalog changes of executed statements since the last catalog refresh
export const STORAGE_CATALOG_CHANGES = 'dashql-catalog-changes.sql';
export const STORAGE_SCRIPT_EXTENSION = '.sql';

export interface DataFile {
    name: string;
    sizeBytes: number;
}

export interface DataFileData {
    name: string;
    bytes: Uint8Array;
}

/// Browser-originated attachments stay as Blobs until OPFS consumes them, avoiding a renderer-memory
/// copy for large picker/drop files. Other persistence paths use bytes.
export type DataFileContent = Uint8Array | Blob;

export function validateDataFileName(name: string): void {
    if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
        throw new Error(`Invalid data file basename: ${name}`);
    }
}

// Re-export JSON Schema types
export type SessionEntry = app_manifest.SessionEntry;
export type StorageManifest = app_manifest.StorageManifest;
export type AppSettings = app_manifest.AppSettings;
export type ConnectionEntry = app_manifest.ConnectionEntry;
export type SessionData = app_session.SessionData;
export type SessionMetadata = app_session.SessionMetadata;
export type SessionSettings = app_session.SessionSettings;
export type SessionScript = app_session.SessionScript;
export type SessionAttachment = app_session.SessionAttachment;
export type SessionConnection = app_session.SessionConnection;
export type ConnectionParams = SessionConnection['params'];

/// The default connection of a validated session
export function defaultSessionConnection(session: SessionData): SessionConnection {
    const connection = session.connections.find(entry => entry.connectionId === session.defaultConnectionId);
    if (connection == null) {
        throw new Error(`Default connection ${session.defaultConnectionId} is missing in session ${session.sessionId}`);
    }
    return connection;
}

/// The kind of filesystem backend
export enum StorageBackendType {
    /// Origin Private File System (browser-only)
    OPFS = 'opfs',
    /// Native filesystem (Electron only)
    Native = 'native',
}

/// Storage interface for DashQL.
///
/// Identity model: the session UUID is authoritative. Every per-session method is keyed by the bare
/// `sessionId` (the UUID). Backends translate that UUID into their own physical layout:
///   - OPFS writes `sessions/<uuid>/…` under the OPFS root.
///   - The native backend is constructed for a single directory and writes that session's files
///     directly into it.
/// There is no storage-prefix concept on this interface anymore; any prefix is purely for display
/// and lives in `session_locator.ts`.
export interface StorageBackend {
    /// Get the backend type
    getBackendType(): StorageBackendType;

    /// Initialize the storage backend (optional)
    initialize?(): Promise<void>;

    /// List all sessions (registry-level)
    listSessions(manifestPath: string): Promise<SessionEntry[]>;

    /// Load persisted app settings from the manifest (registry-level)
    loadAppSettings(): Promise<AppSettings | null>;
    /// Persist app settings to the manifest (registry-level)
    saveAppSettings(settings: AppSettings): Promise<void>;
    /// Load a session by UUID
    loadSession(sessionId: string): Promise<SessionData>;
    /// Save a session
    saveSessionManifest(sessionId: string, data: SessionData): Promise<void>;
    /// Delete a session
    deleteSession(sessionId: string): Promise<void>;

    /// Load the session's flat, naturally ordered script files. The order of the feed is the order
    /// of the scripts in the session file.
    loadScripts(sessionId: string): Promise<ScriptData[]>;
    /// Load a session script
    loadScript(sessionId: string, scriptName: string): Promise<ScriptData>;
    /// Save a session script
    saveScript(sessionId: string, scriptName: string, sql: string): Promise<void>;
    /// Delete a session script
    deleteScript(sessionId: string, scriptName: string): Promise<void>;
    /// Rename a script file, preserving its contents (no rewrite from memory). Callers must
    /// guarantee `oldScriptName` exists and `newScriptName` does not.
    renameScript(sessionId: string, oldScriptName: string, newScriptName: string): Promise<void>;

    listDataFiles(sessionId: string): Promise<DataFile[]>;
    loadDataFile(sessionId: string, name: string): Promise<Uint8Array>;
    saveDataFile(sessionId: string, name: string, content: DataFileContent): Promise<void>;
    deleteDataFile(sessionId: string, name: string): Promise<void>;
    renameDataFile(sessionId: string, oldName: string, newName: string): Promise<void>;

    /// Load a cached query result by content hash, or null on a cache miss.
    ///
    /// The cache lives in a `cache/` folder inside the session's storage; entries are named
    /// `<hash>.arrow`. This is a best-effort cache: callers must treat any failure as a miss and fall
    /// back to normal execution (the executor never lets a cache error surface into the query path).
    /// On a hit the returned entry carries both the Arrow IPC bytes and the file's write time
    /// (`cachedAt`), so the UI can show how old the cached result is.
    loadQueryResultCache(sessionId: string, hash: string): Promise<CachedQueryResult | null>;
    /// Record a cache access by bumping the entry's `<hash>.arrow.last_access` marker's mtime (an
    /// empty file, rewritten so its mtime advances). This is the LRU signal consumed by eviction; it
    /// deliberately does *not* re-touch the payload `.arrow`, so the payload's mtime stays meaningful
    /// as the "cached at" timestamp. Best-effort: callers invoke this on a cache hit and ignore
    /// failures (a missing marker degrades eviction to write-time/FIFO for that entry).
    touchQueryResultCacheAccess(sessionId: string, hash: string): Promise<void>;
    /// Store a query result (Arrow IPC bytes) under `<hash>.arrow` in the session's `cache/` folder,
    /// evicting least-recently-used entries first to stay under the size and count thresholds.
    saveQueryResultCache(sessionId: string, hash: string, bytes: Uint8Array): Promise<void>;
    /// List the session's cached query results with their size and recency metadata (one entry per
    /// `<hash>.arrow` payload; the `.last_access` markers are folded in as `lastAccessMs`). Returns an
    /// empty array when the session has no cache folder yet. This is the read side of the same
    /// listing the eviction policy walks, exposed for the internals cache inspector.
    listQueryResultCache(sessionId: string): Promise<CacheFileStat[]>;
    /// Query result is cached
    hasCachedQueryResult(sessionId: string, hash: string): Promise<boolean>;
    /// Delete a single cached query result by content hash. A no-op when the entry is already gone.
    deleteQueryResultCache(sessionId: string, hash: string): Promise<void>;

    /// Clear all storage (delete all sessions and reset manifest)
    clearAllStorage?(): Promise<void>;
}

/// A backend that also owns the session registry (the root manifest).
///
/// Only the OPFS backend implements this: the OPFS root manifest is the single registry of every
/// session, regardless of where each session's files physically live. The composite backend uses
/// these methods to keep the manifest in sync when a session is relocated to a native directory
/// (the manifest entry stays in OPFS; only the files move).
export interface SessionRegistryBackend extends StorageBackend {
    /// Insert or replace a session's registry entry (matched by UUID), without touching files.
    upsertSessionEntry(entry: SessionEntry): Promise<void>;
    /// Remove a session's registry entry (matched by UUID), without touching files.
    removeSessionEntry(sessionId: string): Promise<void>;
    /// Reorder the registry entries to match the given UUID order (the user-facing session order),
    /// without touching files. Ids not in the manifest are ignored; manifest entries not listed are
    /// kept at the end in their current relative order.
    reorderSessions(orderedIds: string[]): Promise<void>;
    /// Delete a session's files only, leaving the registry entry intact.
    deleteSessionFiles(sessionId: string): Promise<void>;

    /// Load the whole manifest. A manifest without connections was written before connections were
    /// global, the `connections` field is then left absent.
    loadManifest(): Promise<StorageManifest>;
    /// Update the connections of the manifest exclusively.
    /// The update receives the current connections (undefined if the manifest has none yet) and
    /// returns the new connections, or null when nothing changed.
    updateConnections(update: (connections: ConnectionEntry[] | undefined) => ConnectionEntry[] | null): Promise<void>;
    /// Load a file of a connection (e.g. its catalog relations), null if it doesn't exist
    loadConnectionFile(connectionId: string, fileName: string): Promise<string | null>;
    /// Save a file of a connection
    saveConnectionFile(connectionId: string, fileName: string, text: string): Promise<void>;
    /// Delete all files of a connection
    deleteConnectionFiles(connectionId: string): Promise<void>;
}

/// Does a backend own the session registry?
export function isSessionRegistryBackend(backend: StorageBackend): backend is SessionRegistryBackend {
    return typeof (backend as Partial<SessionRegistryBackend>).updateConnections === 'function';
}

// Script data represents a single SQL script
export interface ScriptData {
    /// The script name, the file name in scripts/ (e.g. "extract.sql")
    name: string;
    /// The sql text
    sql: string;
}
