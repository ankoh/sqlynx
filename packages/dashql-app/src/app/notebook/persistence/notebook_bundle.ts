import type { DashQL, FlatBufferPtr, buffers } from '@ankoh/dashql-core';
import type { NotebookData, ScriptData, StorageBackend } from './storage_backend.js';
import { StorageBackendType } from './storage_backend.js';
import {
    describeNotebookValidationError,
    isValidUuid,
    validateNotebookData,
} from './notebook_validation.js';

/// The durable, portable subset of a notebook. Derived cache files and storage-location metadata
/// are intentionally not represented here.
export interface NotebookBundle {
    notebook: NotebookData;
    schemaSql: string | null;
    functionsSql: string | null;
    scripts: ScriptData[];
}

export interface NotebookCatalogValidationResult {
    bundle: NotebookBundle;
    invalidFiles: Array<'dashql-relations.sql' | 'dashql-functions.sql'>;
}

export function regenerateNotebookDatabaseIds(notebook: NotebookData): NotebookData {
    const remap = (database: NotebookData['mainDatabase']) => ({
        ...database,
        databaseId: crypto.randomUUID(),
    });
    return {
        ...notebook,
        mainDatabase: remap(notebook.mainDatabase),
        attachedDatabases: notebook.attachedDatabases.map(remap) as NotebookData['attachedDatabases'],
    };
}

/// Parse catalog files on scratch scripts and omit malformed SQL before it can reach storage.
/// Analysis is intentionally excluded: imported catalogs may reference types or objects that are
/// only available once their connection has been restored.
export function filterInvalidNotebookCatalogs(
    core: DashQL,
    bundle: NotebookBundle,
): NotebookCatalogValidationResult {
    const invalidFiles: NotebookCatalogValidationResult['invalidFiles'] = [];
    const validate = (sql: string | null, fileName: NotebookCatalogValidationResult['invalidFiles'][number]) => {
        if (sql == null || parsesWithoutErrors(core, sql)) return sql;
        invalidFiles.push(fileName);
        return null;
    };
    const schemaSql = validate(bundle.schemaSql, 'dashql-relations.sql');
    const functionsSql = validate(bundle.functionsSql, 'dashql-functions.sql');
    return {
        bundle: schemaSql === bundle.schemaSql && functionsSql === bundle.functionsSql
            ? bundle
            : { ...bundle, schemaSql, functionsSql },
        invalidFiles,
    };
}

function parsesWithoutErrors(core: DashQL, sql: string): boolean {
    const catalog = core.createCatalog();
    const script = core.createScript(catalog);
    let parsed: FlatBufferPtr<buffers.parser.ParsedScript> | null = null;
    try {
        script.replaceText(sql);
        script.parse();
        parsed = script.getParsed();
        const reader = parsed.read();
        return reader.scannerErrorsLength() === 0 && reader.parserErrorsLength() === 0;
    } catch {
        return false;
    } finally {
        parsed?.destroy();
        script.destroy();
        catalog.destroy();
    }
}

export interface NotebookBundleWriteOptions {
    /// Destination UUID. When omitted, preserve the source notebook's authoritative UUID.
    targetNotebookId?: string;
    /// Add " (copy)" to a nonblank source name. Intended for an explicit Create-new operation.
    suffixNameWithCopy?: boolean;
    /// The caller guarantees the destination did not exist before this write. Only then may a
    /// failed whole-bundle write remove the destination as rollback.
    targetIsFresh?: boolean;
    /// Generate fresh attached database identities for a clone/create-new import.
    regenerateDatabaseIds?: boolean;
}

/// Read the portable durable notebook data from a backend. Catalog SQL can be skipped for exports
/// that intentionally omit it; all other durable files are always loaded.
export async function readNotebookBundle(
    notebookId: string,
    backend: StorageBackend,
    withCatalog: boolean = true,
): Promise<NotebookBundle> {
    const [notebook, scripts, schemaSql, functionsSql] = await Promise.all([
        backend.loadNotebook(notebookId),
        backend.loadScripts(notebookId),
        withCatalog ? backend.loadNotebookSchema(notebookId) : null,
        withCatalog ? backend.loadNotebookFunctions(notebookId) : null,
    ]);
    return { notebook, schemaSql, functionsSql, scripts };
}

/// Write a fully parsed bundle to storage. This is deliberately not a replacement transaction:
/// callers replacing an existing notebook must stage and coordinate that operation separately.
export async function writeNotebookBundle(
    bundle: NotebookBundle,
    backend: StorageBackend,
    options: NotebookBundleWriteOptions = {},
): Promise<string> {
    const validation = validateNotebookData(bundle.notebook);
    if (!validation.ok) {
        throw new Error(`Invalid source notebook: ${describeNotebookValidationError(validation.error)}`);
    }
    const notebookId = options.targetNotebookId ?? bundle.notebook.notebookId;
    if (!isValidUuid(notebookId)) {
        throw new Error(`Invalid target notebook id: ${notebookId}`);
    }
    if (options.targetIsFresh && options.targetNotebookId == null) {
        throw new Error('targetIsFresh requires an explicit targetNotebookId');
    }

    let notebook: NotebookData = {
        ...bundle.notebook,
        notebookId,
    };
    if (options.regenerateDatabaseIds) notebook = regenerateNotebookDatabaseIds(notebook);
    if (backend.getBackendType() === StorageBackendType.OPFS) {
        delete notebook.notebookPath;
        delete notebook.storageType;
        delete notebook.nativePath;
    }
    if (options.suffixNameWithCopy) {
        const name = notebook.name?.trim();
        if (name) {
            notebook.name = `${name} (copy)`;
        }
    }

    try {
        await backend.saveNotebookManifest(notebookId, notebook);
        if (bundle.schemaSql != null) {
            await backend.saveNotebookSchema(notebookId, bundle.schemaSql);
        }
        await backend.saveNotebookFunctions(notebookId, bundle.functionsSql ?? '');
        for (const script of bundle.scripts) {
            await backend.saveScript(notebookId, script.name, script.sql);
        }
    } catch (error) {
        if (options.targetIsFresh) {
            try {
                await backend.deleteNotebook(notebookId);
            } catch {
                // Preserve the write error when best-effort rollback also fails.
            }
        }
        throw error;
    }

    return notebookId;
}

/// Compare all portable durable content. Used to verify a staged replacement before touching the
/// live notebook UUID.
export function notebookBundlesEqual(a: NotebookBundle, b: NotebookBundle): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
