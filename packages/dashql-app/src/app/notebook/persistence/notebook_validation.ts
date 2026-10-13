import type { NotebookData, NotebookEntry } from './storage_backend.js';
import { getConnectorInfoForParams, ConnectorType } from '../connections/connector_info.js';

/// A syntactically valid UUID (any version), e.g. the output of `crypto.randomUUID()`.
///
/// Matched case-insensitively and deliberately not pinned to v4: the only requirement is the
/// canonical 8-4-4-4-12 hex shape, which is enough to treat the value as an authoritative notebook
/// key. Anything else (a legacy `opfs://notebooks/<uuid>` path, a slug, an empty string) fails.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// Whether a string is a syntactically valid UUID.
export function isValidUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

/// Why a persisted notebook was rejected during validation.
///
/// These are *metadata* problems detected before any heavy restoration work runs. A notebook that
/// validates here may still hit non-fatal hiccups later (e.g. a catalog that fails to load), but
/// such hiccups never make the notebook "invalid" — they degrade gracefully as before.
export enum NotebookValidationError {
    /// The notebook does not declare persistence format version 2.
    UnsupportedFormatVersion = 'unsupported_format_version',
    /// The notebook has no `notebookId`, or it is empty.
    MissingNotebookId = 'missing_notebook_id',
    /// The `notebookId` is present but is not a syntactically valid UUID.
    InvalidNotebookId = 'invalid_notebook_id',
    /// The notebook's main or attached database collection is malformed.
    InvalidAttachedDatabases = 'invalid_attached_databases',
    /// The attached database has no valid UUID `databaseId`.
    InvalidDatabaseId = 'invalid_database_id',
    /// The main database id is missing, malformed, or does not reference an attached database.
    InvalidMainDatabaseId = 'invalid_main_database_id',
    /// The attached database has no `params`.
    MissingDatabaseParams = 'missing_database_params',
    /// The database `params` do not match any known connector.
    UnknownConnector = 'unknown_connector',
    /// The notebook is registered in the manifest but its files can't be read (e.g. a native notebook
    /// whose folder was moved or deleted on disk, or a corrupt/absent OPFS notebook). Unlike the
    /// errors above this is detected by an actual load failure rather than by inspecting metadata,
    /// but it lands in the same bucket: the notebook can't be opened and should be surfaced as invalid
    /// so the user can remove the stale entry.
    NotebookUnreadable = 'notebook_unreadable',
}

/// A short, human-readable explanation for each validation error, shown in the notebook workbench.
export function describeNotebookValidationError(error: NotebookValidationError): string {
    switch (error) {
        case NotebookValidationError.UnsupportedFormatVersion:
            return 'Unsupported notebook format version';
        case NotebookValidationError.MissingNotebookId:
            return 'Missing notebook id';
        case NotebookValidationError.InvalidNotebookId:
            return 'Invalid notebook id';
        case NotebookValidationError.InvalidAttachedDatabases:
            return 'Notebook must have one main database and a valid attached database list';
        case NotebookValidationError.InvalidDatabaseId:
            return 'Invalid database id';
        case NotebookValidationError.InvalidMainDatabaseId:
            return 'Main database must reference an attached database';
        case NotebookValidationError.MissingDatabaseParams:
            return 'Missing database parameters';
        case NotebookValidationError.UnknownConnector:
            return 'Unknown connector';
        case NotebookValidationError.NotebookUnreadable:
            return 'Notebook files missing';
    }
}

/// The result of validating a notebook's metadata.
export type NotebookValidationResult =
    | { ok: true }
    | { ok: false; error: NotebookValidationError };

/// Validate a notebook's metadata before loading it.
///
/// This is a fail-fast gate run up front in the loader: it rejects notebooks whose metadata is
/// structurally unusable (unsupported format, no id, or an invalid attached database).
/// It deliberately does NOT attempt the full connection decode — `getConnectorInfoForParams` is a
/// non-throwing connector probe, so a notebook that passes here can still be decoded by
/// `decodeConnectionFromProto` during restore.
export function validateNotebookData(data: NotebookData): NotebookValidationResult {
    if ((data as { formatVersion?: unknown }).formatVersion !== 2) {
        return { ok: false, error: NotebookValidationError.UnsupportedFormatVersion };
    }
    if (!data.notebookId) {
        return { ok: false, error: NotebookValidationError.MissingNotebookId };
    }
    if (!isValidUuid(data.notebookId)) {
        return { ok: false, error: NotebookValidationError.InvalidNotebookId };
    }
    if (!data.mainDatabase || !Array.isArray((data as { attachedDatabases?: unknown }).attachedDatabases)) {
        return { ok: false, error: NotebookValidationError.InvalidAttachedDatabases };
    }
    const databaseIds = new Set<string>();
    for (const database of [data.mainDatabase, ...data.attachedDatabases]) {
        if (!database || !isValidUuid(database.databaseId) || databaseIds.has(database.databaseId)) {
            return { ok: false, error: NotebookValidationError.InvalidDatabaseId };
        }
        databaseIds.add(database.databaseId);
        if (!database.params) {
            return { ok: false, error: NotebookValidationError.MissingDatabaseParams };
        }
        if (getConnectorInfoForParams(database.params as any) == null) {
            return { ok: false, error: NotebookValidationError.UnknownConnector };
        }
        if (database.paramsDraft != null && getConnectorInfoForParams(database.paramsDraft as any)?.connectorType
            !== getConnectorInfoForParams(database.params as any)?.connectorType) {
            return { ok: false, error: NotebookValidationError.UnknownConnector };
        }
    }
    return { ok: true };
}

export function isLocalHyperWasmParams(params: NotebookData['attachedDatabases'][number]['params']): boolean {
    return 'hyper' in params && (params.hyper?.protocol ?? 'WASM') === 'WASM';
}

/// A notebook that failed metadata validation and was refused a load.
///
/// Carried out of the loader so the notebook workbench can surface it (marked invalid, blocked from
/// opening, still deletable). It holds just enough to render and to delete the notebook: the bare
/// UUID (the storage key), a best-effort title, a connector type for the icon when one could be
/// inferred, and the reason it was rejected.
export interface InvalidNotebook {
    /// The bare notebook UUID — the key used for routing and for `deleteNotebook`.
    notebookId: string;
    /// A best-effort display title (falls back to the display path / UUID).
    title: string;
    /// The connector type if it could be inferred from the params, else null.
    connectorType: ConnectorType | null;
    /// Why the notebook was rejected.
    error: NotebookValidationError;
}

/// Build an `InvalidNotebook` record from whatever metadata is available.
///
/// `data` may be absent (e.g. the notebook file failed to load/parse entirely), in which case we
/// fall back to the manifest entry's path for the id and title.
export function describeInvalidNotebook(
    entry: NotebookEntry,
    error: NotebookValidationError,
    data: NotebookData | null,
): InvalidNotebook {
    // The manifest entry's path is the authoritative registry key, so it is what `deleteNotebook`
    // must be handed to evict the notebook — not `data.notebookId`, which is exactly the field that
    // may be missing or malformed on an invalid notebook.
    const notebookId = entry.path;
    const params = data?.mainDatabase?.params;
    const connectorInfo = params
        ? getConnectorInfoForParams(params as any)
        : null;
    return {
        notebookId,
        title: data?.name || data?.notebookPath || notebookId,
        connectorType: connectorInfo?.connectorType ?? null,
        error,
    };
}
