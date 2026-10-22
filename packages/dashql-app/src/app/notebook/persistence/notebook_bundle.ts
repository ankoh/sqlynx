import type { DashQL, FlatBufferPtr, buffers } from '@ankoh/dashql-core';
import type { DataFileData, NotebookData, ScriptData, StorageBackend } from './storage_backend.js';
import { STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_RELATIONS, StorageBackendType, validateDataFileName } from './storage_backend.js';
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
    data?: DataFileData[];
}

export interface NotebookCatalogValidationResult {
    bundle: NotebookBundle;
    invalidFiles: Array<typeof STORAGE_CATALOG_RELATIONS | typeof STORAGE_CATALOG_FUNCTIONS>;
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

/// Rewrite only this notebook's canonical attachment paths after explicitly creating a new identity.
/// References to another notebook are left unchanged.
export function rebaseNotebookAttachmentPaths(text: string | null, sourceNotebookId: string, targetNotebookId: string): string | null {
    if (text == null || sourceNotebookId === targetNotebookId) return text;
    return text.split(
        `/mnt/fs/notebooks/${sourceNotebookId}/attachments/`,
    ).join(`/mnt/fs/notebooks/${targetNotebookId}/attachments/`);
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
    const schemaSql = validate(bundle.schemaSql, STORAGE_CATALOG_RELATIONS);
    const functionsSql = validate(bundle.functionsSql, STORAGE_CATALOG_FUNCTIONS);
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
    const data = await Promise.all((await backend.listDataFiles(notebookId))
        .map(async file => ({ name: file.name, bytes: await backend.loadDataFile(notebookId, file.name) })));
    return { notebook, schemaSql, functionsSql, scripts, data };
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
    for (const file of bundle.data ?? []) validateDataFileName(file.name);

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
        const schemaSql = rebaseNotebookAttachmentPaths(bundle.schemaSql, bundle.notebook.notebookId, notebookId);
        const functionsSql = rebaseNotebookAttachmentPaths(bundle.functionsSql ?? '', bundle.notebook.notebookId, notebookId)!;
        if (schemaSql != null) {
            await backend.saveNotebookSchema(notebookId, schemaSql);
        }
        await backend.saveNotebookFunctions(notebookId, functionsSql);
        for (const script of bundle.scripts) {
            await backend.saveScript(notebookId, script.name,
                rebaseNotebookAttachmentPaths(script.sql, bundle.notebook.notebookId, notebookId)!);
        }
        for (const file of bundle.data ?? []) {
            await backend.saveDataFile(notebookId, file.name, file.bytes);
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
    const { data: aData = [], ...aText } = a;
    const { data: bData = [], ...bText } = b;
    return JSON.stringify(aText) === JSON.stringify(bText)
        && aData.length === bData.length
        && aData.every((file, i) => file.name === bData[i].name
            && file.bytes.byteLength === bData[i].bytes.byteLength
            && file.bytes.every((byte, j) => byte === bData[i].bytes[j]));
}
