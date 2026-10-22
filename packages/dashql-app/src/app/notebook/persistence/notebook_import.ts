import JSZip from 'jszip';

import type { NotebookData, ScriptData, StorageBackend } from './storage_backend.js';
import {
    STORAGE_NOTEBOOK_FILE,
    STORAGE_ATTACHMENTS_FOLDER,
    validateDataFileName,
    STORAGE_SCRIPTS_FOLDER,
    LEGACY_STORAGE_CATALOG_FUNCTIONS,
    LEGACY_STORAGE_CATALOG_RELATIONS,
    STORAGE_CATALOG_FUNCTIONS,
    STORAGE_CATALOG_RELATIONS,
} from './storage_backend.js';
import type { NotebookBundle, NotebookBundleWriteOptions } from './notebook_bundle.js';
import { writeNotebookBundle } from './notebook_bundle.js';
import { describeNotebookValidationError, validateNotebookData } from './notebook_validation.js';

export interface NotebookZipImportOptions extends NotebookBundleWriteOptions { }

type NotebookZipImportOptionsInput = NotebookZipImportOptions | (() => string);

type ZipObjectWithOriginalName = JSZip.JSZipObject & { unsafeOriginalName?: string };

interface ParsedZipEntry {
    path: string;
    file: JSZip.JSZipObject;
}

const NATURAL_SORT = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/// Parse and validate a portable notebook ZIP without modifying storage.
export async function readNotebookBundleFromZip(zipBlob: Blob): Promise<NotebookBundle> {
    const zip = await JSZip.loadAsync(zipBlob);
    const destinations = new Map<string, ParsedZipEntry>();

    for (const file of Object.values(zip.files)) {
        const originalPath = (file as ZipObjectWithOriginalName).unsafeOriginalName ?? file.name;
        validateDataPath(originalPath);
        const path = normalizeBundlePath(originalPath);
        validateDataPath(path);
        if (file.dir) continue;
        if (!isBundleFile(path)) {
            continue;
        }
        const key = destinationKey(path);
        if (destinations.has(key)) {
            throw new Error(`Invalid ZIP: duplicate destination ${path}`);
        }
        destinations.set(key, { path, file });
    }

    const manifest = destinations.get(destinationKey(STORAGE_NOTEBOOK_FILE));
    if (!manifest) {
        throw new Error(`Invalid ZIP: missing ${STORAGE_NOTEBOOK_FILE}`);
    }

    let parsedNotebook: unknown;
    try {
        parsedNotebook = JSON.parse(await manifest.file.async('text'));
    } catch {
        throw new Error(`Invalid ZIP: invalid ${STORAGE_NOTEBOOK_FILE}`);
    }
    if (parsedNotebook == null || typeof parsedNotebook !== 'object' || Array.isArray(parsedNotebook)) {
        throw new Error(`Invalid ZIP: invalid ${STORAGE_NOTEBOOK_FILE}`);
    }
    const notebook = parsedNotebook as NotebookData;
    const validation = validateNotebookData(notebook);
    if (!validation.ok) {
        throw new Error(
            `Invalid ZIP: invalid ${STORAGE_NOTEBOOK_FILE}: ${describeNotebookValidationError(validation.error)}`,
        );
    }

    // Bundles of older versions name the catalog files differently
    const schema = destinations.get(destinationKey(STORAGE_CATALOG_RELATIONS))
        ?? destinations.get(destinationKey(LEGACY_STORAGE_CATALOG_RELATIONS));
    const functions = destinations.get(destinationKey(STORAGE_CATALOG_FUNCTIONS))
        ?? destinations.get(destinationKey(LEGACY_STORAGE_CATALOG_FUNCTIONS));
    const scripts: Array<{ name: string; file: JSZip.JSZipObject }> = [];

    for (const entry of destinations.values()) {
        const entryKey = destinationKey(entry.path);
        if (!entryKey.startsWith(`${destinationKey(STORAGE_SCRIPTS_FOLDER)}/`)) {
            continue;
        }
        const parts = entry.path.split('/');
        if (!entryKey.endsWith('.sql')) {
            continue;
        }
        if (parts.length !== 2) {
            throw new Error(`Invalid ZIP: SQL scripts must be directly inside scripts/: ${entry.path}`);
        }
        const [, scriptName] = parts;
        if (destinationKey(scriptName) === destinationKey('dashql-draft.sql')) {
            throw new Error(`Invalid ZIP: draft scripts are not supported: ${entry.path}`);
        }
        scripts.push({ name: scriptName, file: entry.file });
    }

    const parsedScripts: ScriptData[] = await Promise.all(scripts
        .sort((a, b) => NATURAL_SORT.compare(a.name, b.name))
        .map(async script => ({ name: script.name, sql: await script.file.async('text') })));

    const [schemaSql, functionsSql] = await Promise.all([
        schema ? schema.file.async('text') : null,
        functions ? functions.file.async('text') : null,
    ]);

    const data = await Promise.all([...destinations.values()]
        .filter(entry => destinationKey(entry.path).startsWith(`${STORAGE_ATTACHMENTS_FOLDER}/`))
        .sort((a, b) => NATURAL_SORT.compare(a.path, b.path))
        .map(async entry => ({ name: entry.path.split('/')[1], bytes: await entry.file.async('uint8array') })));
    return { notebook, schemaSql, functionsSql, scripts: parsedScripts, data };
}

function validateDataPath(path: string): void {
    if (!path.replace(/\\/g, '/').toLowerCase().startsWith(`${STORAGE_ATTACHMENTS_FOLDER}/`)) return;
    if (path.toLowerCase() === `${STORAGE_ATTACHMENTS_FOLDER}/`) return;
    const parts = path.split('/');
    if (parts.length !== 2 || parts[0].toLowerCase() !== STORAGE_ATTACHMENTS_FOLDER) {
        throw new Error(`Invalid ZIP: attachments must be directly inside attachments/: ${path}`);
    }
    validateDataFileName(parts[1]);
}

/// Import a portable notebook ZIP. By default the source UUID is preserved.
export async function importNotebookFromZip(
    zipBlob: Blob,
    backend: StorageBackend,
    optionsInput: NotebookZipImportOptionsInput = {},
): Promise<string> {
    const bundle = await readNotebookBundleFromZip(zipBlob);
    const options = typeof optionsInput === 'function'
        ? { targetNotebookId: optionsInput(), targetIsFresh: true, regenerateDatabaseIds: true }
        : optionsInput;
    return await writeNotebookBundle(bundle, backend, options);
}

function normalizeBundlePath(input: string): string {
    if (input.includes('\0')) throw new Error(`Invalid ZIP: NUL in path ${input}`);
    const path = input.replace(/\\/g, '/');
    if (path.startsWith('/')) {
        throw new Error(`Invalid ZIP: absolute path ${input}`);
    }
    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            throw new Error(`Invalid ZIP: path traversal ${input}`);
        }
        parts.push(part.normalize('NFC'));
    }
    return parts.join('/');
}

function destinationKey(path: string): string {
    return path.normalize('NFC').toLowerCase();
}

function isBundleFile(path: string): boolean {
    const key = destinationKey(path);
    return key === destinationKey(STORAGE_NOTEBOOK_FILE)
        || key === destinationKey(STORAGE_CATALOG_RELATIONS)
        || key === destinationKey(STORAGE_CATALOG_FUNCTIONS)
        || key === destinationKey(LEGACY_STORAGE_CATALOG_RELATIONS)
        || key === destinationKey(LEGACY_STORAGE_CATALOG_FUNCTIONS)
        || key.startsWith(`${STORAGE_ATTACHMENTS_FOLDER}/`)
        || (key.startsWith(`${destinationKey(STORAGE_SCRIPTS_FOLDER)}/`) && key.endsWith('.sql'));
}
