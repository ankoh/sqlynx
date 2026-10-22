import JSZip from 'jszip';

import type { ScriptData, StorageBackend } from '../../storage/storage_backend.js';
import {
    STORAGE_ATTACHMENTS_FOLDER,
    validateDataFileName,
    STORAGE_SCRIPTS_FOLDER,
} from '../../storage/storage_backend.js';
import type { SessionBundle, SessionBundleWriteOptions } from '../../storage/session_bundle.js';
import { readSessionBundleHead, writeSessionBundle } from '../../storage/session_bundle.js';
import { MemoryFolder } from '../../../migration/migration_folder.js';

export interface SessionZipImportOptions extends SessionBundleWriteOptions { }

type SessionZipImportOptionsInput = SessionZipImportOptions | (() => string);

type ZipObjectWithOriginalName = JSZip.JSZipObject & { unsafeOriginalName?: string };

interface ParsedZipEntry {
    path: string;
    file: JSZip.JSZipObject;
}

const NATURAL_SORT = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/// Parse and validate a portable session ZIP without modifying storage.
export async function readSessionBundleFromZip(zipBlob: Blob): Promise<SessionBundle> {
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

    // The top-level files are migrated in memory, the scripts and attachments are read as they are
    const head = await readSessionBundleHead(new MemoryFolder(await Promise.all([...destinations]
        .filter(([key]) => isTopLevelFile(key))
        .map(async ([key, entry]) => [key, await entry.file.async('text')] as [string, string]))), 'Invalid ZIP');

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

    const data = await Promise.all([...destinations.values()]
        .filter(entry => destinationKey(entry.path).startsWith(`${STORAGE_ATTACHMENTS_FOLDER}/`))
        .sort((a, b) => NATURAL_SORT.compare(a.path, b.path))
        .map(async entry => ({ name: entry.path.split('/')[1], bytes: await entry.file.async('uint8array') })));
    return { ...head, scripts: parsedScripts, data };
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

/// Import a portable session ZIP. By default the source UUID is preserved.
export async function importSessionFromZip(
    zipBlob: Blob,
    backend: StorageBackend,
    optionsInput: SessionZipImportOptionsInput = {},
): Promise<string> {
    const bundle = await readSessionBundleFromZip(zipBlob);
    const options = typeof optionsInput === 'function'
        ? { targetSessionId: optionsInput(), targetIsFresh: true, regenerateDatabaseIds: true }
        : optionsInput;
    return await writeSessionBundle(bundle, backend, options);
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

/// Is the path a top-level file of the session folder? Older versions name the files differently,
/// the session migration needs any of them.
function isTopLevelFile(key: string): boolean {
    return !key.includes('/') && key.startsWith('dashql-');
}

function isBundleFile(path: string): boolean {
    const key = destinationKey(path);
    return isTopLevelFile(key)
        || key.startsWith(`${STORAGE_ATTACHMENTS_FOLDER}/`)
        || (key.startsWith(`${destinationKey(STORAGE_SCRIPTS_FOLDER)}/`) && key.endsWith('.sql'));
}
