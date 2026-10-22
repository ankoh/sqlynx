import type { SessionData, ScriptData } from './storage_backend.js';
import {
    STORAGE_SESSION_FILE,
    LEGACY_STORAGE_SESSION_FILE,
    STORAGE_ATTACHMENTS_FOLDER,
    validateDataFileName,
    STORAGE_SCRIPTS_FOLDER,
    LEGACY_STORAGE_CATALOG_FUNCTIONS,
    LEGACY_STORAGE_CATALOG_RELATIONS,
    STORAGE_CATALOG_FUNCTIONS,
    STORAGE_CATALOG_RELATIONS,
} from './storage_backend.js';
import type { SessionBundle } from './session_bundle.js';
import { describeSessionValidationError, validateSessionData } from './session_validation.js';
import { migrateSessionData } from './session_file_migration.js';

interface BrowserFolderEntry {
    path: string;
    sourcePath: string;
    file: File;
}

const NATURAL_SORT = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/// Parse a session folder selected by an input with `webkitdirectory`. Browsers do not include
/// directory entries in FileList, so explicitly empty script folders cannot be preserved.
export async function readSessionBundleFromBrowserFolder(
    selectedFiles: FileList | readonly File[],
): Promise<SessionBundle> {
    const entries: BrowserFolderEntry[] = [];
    let rootName: string | null = null;
    let usesRelativePaths: boolean | null = null;

    for (const file of Array.from(selectedFiles)) {
        const hasRelativePath = (file.webkitRelativePath?.length ?? 0) > 0;
        if (usesRelativePaths == null) {
            usesRelativePaths = hasRelativePath;
        } else if (usesRelativePaths !== hasRelativePath) {
            throw new Error('Invalid session folder: selection mixes rooted and fallback file paths');
        }
        const selectedPath = hasRelativePath ? file.webkitRelativePath : file.name;
        const rawPath = hasRelativePath ? selectedPath.split('/').slice(1).join('/') : selectedPath;
        if (rawPath.replace(/\\/g, '/').toLowerCase().startsWith(`${STORAGE_ATTACHMENTS_FOLDER}/`)) {
            const parts = rawPath.split('/');
            if (parts.length !== 2 || parts[0].toLowerCase() !== STORAGE_ATTACHMENTS_FOLDER) {
                throw new Error(`Invalid session folder: attachments must be directly inside attachments/: ${rawPath}`);
            }
            validateDataFileName(parts[1]);
        }
        const { path, sourcePath } = normalizeSelectedPath(selectedPath);
        const parts = path.split('/');
        const sourceParts = sourcePath.split('/');
        if (hasRelativePath) {
            if (parts.length < 2) {
                throw new Error(`Invalid session folder: file is outside a selected root folder: ${selectedPath}`);
            }
            parts.shift();
            const sourceRoot = sourceParts.shift()!;
            if (rootName == null) {
                rootName = sourceRoot;
            } else if (rootName !== sourceRoot) {
                throw new Error('Invalid session folder: selection contains multiple root folders');
            }
        }
        entries.push({ path: parts.join('/'), sourcePath: sourceParts.join('/'), file });
    }

    const destinations = new Map<string, BrowserFolderEntry>();
    for (const entry of entries) {
        const classification = classifyBundlePath(entry.path);
        if (classification === 'ignore') {
            continue;
        }
        if (classification === 'invalid-script') {
            throw new Error(
                `Invalid session folder: SQL scripts must be directly inside scripts/: ${entry.path}`,
            );
        }
        if (classification === 'invalid-data') {
            throw new Error(`Invalid session folder: attachments must be directly inside attachments/: ${entry.path}`);
        }

        const key = destinationKey(entry.path);
        if (destinations.has(key)) {
            throw new Error(`Invalid session folder: duplicate destination ${entry.path}`);
        }
        destinations.set(key, entry);

    }

    // Folders of older versions name the session file differently
    const manifestKey = [STORAGE_SESSION_FILE, LEGACY_STORAGE_SESSION_FILE]
        .map(destinationKey)
        .find(key => destinations.has(key));
    if (manifestKey === undefined) {
        throw new Error(`Invalid session folder: missing ${STORAGE_SESSION_FILE}`);
    }

    const contents = new Map<string, string>();
    await Promise.all([...destinations].map(async ([key, entry]) => {
        if (classifyBundlePath(entry.path) === 'data') return;
        contents.set(key, await entry.file.text());
    }));

    let parsedSession: unknown;
    try {
        parsedSession = JSON.parse(contents.get(manifestKey)!);
    } catch {
        throw new Error(`Invalid session folder: invalid ${STORAGE_SESSION_FILE}`);
    }
    if (parsedSession == null || typeof parsedSession !== 'object' || Array.isArray(parsedSession)) {
        throw new Error(`Invalid session folder: invalid ${STORAGE_SESSION_FILE}`);
    }
    const session = migrateSessionData(parsedSession as SessionData);
    const validation = validateSessionData(session);
    if (!validation.ok) {
        throw new Error(
            `Invalid session folder: invalid ${STORAGE_SESSION_FILE}: ${describeSessionValidationError(validation.error)}`,
        );
    }

    const scripts: ScriptData[] = [...destinations]
        .filter(([, entry]) => classifyBundlePath(entry.path) === 'script')
        .map(([key, entry]) => ({
            name: entry.path.split('/')[1],
            sql: contents.get(key)!,
        }))
        .sort((a, b) => NATURAL_SORT.compare(a.name, b.name));

    return {
        session,
        // Folders of older versions name the catalog files differently
        schemaSql: getOptionalContent(contents, STORAGE_CATALOG_RELATIONS) ?? getOptionalContent(contents, LEGACY_STORAGE_CATALOG_RELATIONS),
        functionsSql: getOptionalContent(contents, STORAGE_CATALOG_FUNCTIONS) ?? getOptionalContent(contents, LEGACY_STORAGE_CATALOG_FUNCTIONS),
        scripts,
        data: await Promise.all([...destinations.values()]
            .filter(entry => classifyBundlePath(entry.path) === 'data')
            .sort((a, b) => NATURAL_SORT.compare(a.path, b.path))
            .map(async entry => ({ name: entry.path.split('/')[1], bytes: new Uint8Array(await entry.file.arrayBuffer()) }))),
    };
}

function normalizeSelectedPath(input: string): { path: string; sourcePath: string } {
    if (input.includes('\0')) throw new Error(`Invalid session folder: NUL in path ${input}`);
    const path = input.replace(/\\/g, '/');
    if (path.startsWith('/') || /^[a-z]:\//i.test(path)) {
        throw new Error(`Invalid session folder: absolute path ${input}`);
    }
    const sourceParts: string[] = [];
    for (const part of path.split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            throw new Error(`Invalid session folder: path traversal ${input}`);
        }
        sourceParts.push(part);
    }
    return {
        path: sourceParts.map(part => part.normalize('NFC')).join('/'),
        sourcePath: sourceParts.join('/'),
    };
}

function classifyBundlePath(path: string): 'accept' | 'script' | 'data' | 'ignore' | 'invalid-script' | 'invalid-data' {
    const key = destinationKey(path);
    if (key.startsWith(`${STORAGE_ATTACHMENTS_FOLDER}/`)) {
        const parts = path.split('/');
        if (parts.length !== 2) return 'invalid-data';
        validateDataFileName(parts[1]);
        return 'data';
    }
    if (key === destinationKey(STORAGE_SESSION_FILE)
        || key === destinationKey(LEGACY_STORAGE_SESSION_FILE)
        || key === destinationKey(STORAGE_CATALOG_RELATIONS)
        || key === destinationKey(STORAGE_CATALOG_FUNCTIONS)
        || key === destinationKey(LEGACY_STORAGE_CATALOG_RELATIONS)
        || key === destinationKey(LEGACY_STORAGE_CATALOG_FUNCTIONS)) {
        return 'accept';
    }

    const scriptsPrefix = `${destinationKey(STORAGE_SCRIPTS_FOLDER)}/`;
    if (!key.startsWith(scriptsPrefix) || !key.endsWith('.sql')) {
        return 'ignore';
    }
    const parts = path.split('/');
    if (parts.length !== 2) {
        return 'invalid-script';
    }
    if (destinationKey(parts[1]) === destinationKey('dashql-draft.sql')) {
        return 'invalid-script';
    }
    return 'script';
}

function destinationKey(path: string): string {
    return path.normalize('NFC').toLowerCase();
}

function getOptionalContent(contents: Map<string, string>, path: string): string | null {
    return contents.get(destinationKey(path)) ?? null;
}
