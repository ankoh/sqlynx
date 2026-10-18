import type * as app_manifest from '@ankoh/dashql-jsonschema/app_manifest.js';
import type * as app_notebook from '@ankoh/dashql-jsonschema/app_notebook.js';

import type { CacheFileStat } from './query_result_cache_eviction.js';
import type { CachedQueryResult } from '../../../query/query_result_cache.js';
export type { CachedQueryResult } from '../../../query/query_result_cache.js';

// Storage file and folder naming conventions
export const STORAGE_MANIFEST_FILE = 'dashql-manifest.json';
export const STORAGE_NOTEBOOKS_FOLDER = 'notebooks';
export const STORAGE_NOTEBOOK_FILE = 'dashql-notebook.json';
export const STORAGE_NOTEBOOK_INDEX_FILE = 'dashql-notebook-index.json';
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
export const STORAGE_SHELL_FOLDER = 'dashql-shell';

export const STORAGE_SCRIPT_SCHEMA = 'dashql-relations.sql';
export const STORAGE_SCRIPT_FUNCTIONS = 'dashql-functions.sql';
export const STORAGE_SCRIPT_EXTENSION = '.sql';

export interface NotebookIndexScript {
    name: string;
}

export interface NotebookIndexData {
    scripts: NotebookIndexScript[];
    data?: NotebookIndexScript[];
}

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
export type NotebookEntry = app_manifest.NotebookEntry;
export type StorageManifest = app_manifest.StorageManifest;
export type AppSettings = app_manifest.AppSettings;
export type AIModels = app_manifest.AIModels;
export type NotebookData = app_notebook.NotebookData;
export type NotebookMetadata = app_notebook.NotebookMetadata;
export type AttachedDatabase = app_notebook.AttachedDatabase;
export type ConnectionParams = AttachedDatabase['params'];

/// The kind of filesystem backend
export enum StorageBackendType {
    /// Origin Private File System (browser-only)
    OPFS = 'opfs',
    /// Native filesystem (Electron only)
    Native = 'native',
}

/// Storage interface for DashQL.
///
/// Identity model: the notebook UUID is authoritative. Every per-notebook method is keyed by the bare
/// `notebookId` (the UUID). Backends translate that UUID into their own physical layout:
///   - OPFS writes `notebooks/<uuid>/…` under the OPFS root.
///   - The native backend is constructed for a single directory and writes that notebook's files
///     directly into it.
/// There is no storage-prefix concept on this interface anymore; any prefix is purely for display
/// and lives in `notebook_locator.ts`.
export interface StorageBackend {
    /// Get the backend type
    getBackendType(): StorageBackendType;

    /// Initialize the storage backend (optional)
    initialize?(): Promise<void>;

    /// List all notebooks (registry-level)
    listNotebooks(manifestPath: string): Promise<NotebookEntry[]>;

    /// Load persisted app settings from the manifest (registry-level)
    loadAppSettings(): Promise<AppSettings | null>;
    /// Persist app settings to the manifest (registry-level)
    saveAppSettings(settings: AppSettings): Promise<void>;
    /// Load the AI models from the manifest (registry-level)
    loadAIModels(): Promise<AIModels | null>;
    /// Persist the AI models to the manifest (registry-level)
    saveAIModels(models: AIModels): Promise<void>;
    /// Load a notebook by UUID
    loadNotebook(notebookId: string): Promise<NotebookData>;
    /// Save a notebook
    saveNotebookManifest(notebookId: string, data: NotebookData): Promise<void>;
    /// Create the derived HTTP publication index only when it is missing.
    ensureNotebookIndex?(notebookId: string): Promise<void>;
    /// Rewrite the derived HTTP publication index from the authoritative script and data trees.
    regenerateNotebookIndex?(notebookId: string): Promise<void>;
    /// Delete a notebook
    deleteNotebook(notebookId: string): Promise<void>;

    /// Load notebook catalog schema SQL
    loadNotebookSchema(notebookId: string): Promise<string | null>;
    /// Save notebook catalog schema SQL
    saveNotebookSchema(notebookId: string, sql: string): Promise<void>;

    /// Load notebook catalog functions SQL
    loadNotebookFunctions(notebookId: string): Promise<string | null>;
    /// Save notebook catalog functions SQL
    saveNotebookFunctions(notebookId: string, sql: string): Promise<void>;

    /// Load the notebook's flat, naturally ordered script collection.
    loadScripts(notebookId: string): Promise<ScriptData[]>;
    /// Load a notebook script
    loadScript(notebookId: string, scriptName: string): Promise<ScriptData>;
    /// Save a notebook script
    saveScript(notebookId: string, scriptName: string, sql: string): Promise<void>;
    /// Delete a notebook script
    deleteScript(notebookId: string, scriptName: string): Promise<void>;
    /// Rename a script file, preserving its contents (no rewrite from memory). Callers must
    /// guarantee `oldScriptName` exists and `newScriptName` does not.
    renameScript(notebookId: string, oldScriptName: string, newScriptName: string): Promise<void>;

    listDataFiles(notebookId: string): Promise<DataFile[]>;
    loadDataFile(notebookId: string, name: string): Promise<Uint8Array>;
    saveDataFile(notebookId: string, name: string, content: DataFileContent): Promise<void>;
    deleteDataFile(notebookId: string, name: string): Promise<void>;
    renameDataFile(notebookId: string, oldName: string, newName: string): Promise<void>;

    /// Load a cached query result by content hash, or null on a cache miss.
    ///
    /// The cache lives in a `cache/` folder inside the notebook's storage; entries are named
    /// `<hash>.arrow`. This is a best-effort cache: callers must treat any failure as a miss and fall
    /// back to normal execution (the executor never lets a cache error surface into the query path).
    /// On a hit the returned entry carries both the Arrow IPC bytes and the file's write time
    /// (`cachedAt`), so the UI can show how old the cached result is.
    loadQueryResultCache(notebookId: string, hash: string): Promise<CachedQueryResult | null>;
    /// Record a cache access by bumping the entry's `<hash>.arrow.last_access` marker's mtime (an
    /// empty file, rewritten so its mtime advances). This is the LRU signal consumed by eviction; it
    /// deliberately does *not* re-touch the payload `.arrow`, so the payload's mtime stays meaningful
    /// as the "cached at" timestamp. Best-effort: callers invoke this on a cache hit and ignore
    /// failures (a missing marker degrades eviction to write-time/FIFO for that entry).
    touchQueryResultCacheAccess(notebookId: string, hash: string): Promise<void>;
    /// Store a query result (Arrow IPC bytes) under `<hash>.arrow` in the notebook's `cache/` folder,
    /// evicting least-recently-used entries first to stay under the size and count thresholds.
    saveQueryResultCache(notebookId: string, hash: string, bytes: Uint8Array): Promise<void>;
    /// List the notebook's cached query results with their size and recency metadata (one entry per
    /// `<hash>.arrow` payload; the `.last_access` markers are folded in as `lastAccessMs`). Returns an
    /// empty array when the notebook has no cache folder yet. This is the read side of the same
    /// listing the eviction policy walks, exposed for the internals cache inspector.
    listQueryResultCache(notebookId: string): Promise<CacheFileStat[]>;
    /// Query result is cached
    hasCachedQueryResult(notebookId: string, hash: string): Promise<boolean>;
    /// Delete a single cached query result by content hash. A no-op when the entry is already gone.
    deleteQueryResultCache(notebookId: string, hash: string): Promise<void>;

    /// Clear all storage (delete all notebooks and reset manifest)
    clearAllStorage?(): Promise<void>;
}

/// A backend that also owns the notebook registry (the root manifest).
///
/// Only the OPFS backend implements this: the OPFS root manifest is the single registry of every
/// notebook, regardless of where each notebook's files physically live. The composite backend uses
/// these methods to keep the manifest in sync when a notebook is relocated to a native directory
/// (the manifest entry stays in OPFS; only the files move).
export interface NotebookRegistryBackend extends StorageBackend {
    /// Insert or replace a notebook's registry entry (matched by UUID), without touching files.
    upsertNotebookEntry(entry: NotebookEntry): Promise<void>;
    /// Remove a notebook's registry entry (matched by UUID), without touching files.
    removeNotebookEntry(notebookId: string): Promise<void>;
    /// Reorder the registry entries to match the given UUID order (the user-facing notebook order),
    /// without touching files. Ids not in the manifest are ignored; manifest entries not listed are
    /// kept at the end in their current relative order.
    reorderNotebooks(orderedIds: string[]): Promise<void>;
    /// Delete a notebook's files only, leaving the registry entry intact.
    deleteNotebookFiles(notebookId: string): Promise<void>;
}

// Script data represents a single SQL script
export interface ScriptData {
    /// The script name (matches filename: "01-script.sql", "02-query.sql", etc.)
    name: string;
    /// The sql text
    sql: string;
}
