import type { HttpClient, HttpFetchResult } from '../../../platform/http/http_client.js';
import type {
    SessionData,
    DataFileData,
    SessionIndexData,
    SessionIndexScript,
    ScriptData,
} from './storage_backend.js';
import {
    STORAGE_SESSION_FILE,
    STORAGE_ATTACHMENTS_FOLDER,
    STORAGE_SESSION_INDEX_FILE,
    STORAGE_SCRIPTS_FOLDER,
    STORAGE_CATALOG_FUNCTIONS,
    STORAGE_CATALOG_RELATIONS,
} from './storage_backend.js';
import type { SessionBundle } from './session_bundle.js';
import { describeSessionValidationError, validateSessionData } from './session_validation.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_SCRIPTS = 2048;

export interface HttpSessionLoadResult {
    bundle: SessionBundle;
    indexedScriptCount: number;
    loadedScriptCount: number;
    incomplete: boolean;
}

export type HttpSessionLoadProgress =
    | { phase: 'preparing' }
    | { phase: 'manifest' }
    | { phase: 'index'; sessionName: string; sessionId: string }
    | {
        phase: 'files';
        sessionName: string;
        sessionId: string;
        completedFileCount: number;
        totalFileCount: number;
        completedScriptCount: number;
        totalScriptCount: number;
    };

export async function readSessionBundleFromHttp(
    manifestUrl: URL,
    httpClient: HttpClient,
    signal?: AbortSignal,
    onProgress?: (progress: HttpSessionLoadProgress) => void,
): Promise<HttpSessionLoadResult> {
    validateManifestUrl(manifestUrl);
    const baseUrl = new URL('./', manifestUrl);
    let totalBytes = 0;

    onProgress?.({ phase: 'manifest' });
    const manifestText = await fetchRequiredText(httpClient, manifestUrl, STORAGE_SESSION_FILE, MAX_MANIFEST_BYTES, signal);
    totalBytes += textBytes(manifestText);
    const session = parseSession(manifestText);
    const sessionName = session.name?.trim() || session.metadata.originalFileName || 'Unnamed session';

    onProgress?.({ phase: 'index', sessionName, sessionId: session.sessionId });
    const indexText = await fetchBestEffortText(
        httpClient,
        new URL(STORAGE_SESSION_INDEX_FILE, baseUrl),
        MAX_INDEX_BYTES,
        signal,
    );
    totalBytes += indexText == null ? 0 : textBytes(indexText);
    const parsedIndex = parseSessionIndex(indexText);
    const index = parsedIndex.index;
    const indexedScriptCount = index.scripts.length;
    const totalFileCount = 4 + indexedScriptCount + (index.data?.length ?? 0);
    let completedFileCount = 2;
    let completedScriptCount = 0;
    const reportFileProgress = () => onProgress?.({
        phase: 'files',
        sessionName,
        sessionId: session.sessionId,
        completedFileCount,
        totalFileCount,
        completedScriptCount,
        totalScriptCount: indexedScriptCount,
    });
    const trackFile = async <T>(load: Promise<T>, script: boolean = false): Promise<T> => {
        try {
            return await load;
        } finally {
            completedFileCount += 1;
            if (script) completedScriptCount += 1;
            reportFileProgress();
        }
    };
    reportFileProgress();

    const fetchCatalogFile = async (name: string) =>
        await fetchBestEffortText(httpClient, new URL(name, baseUrl), MAX_SCRIPT_BYTES, signal);
    const optional = await Promise.all([
        trackFile(fetchCatalogFile(STORAGE_CATALOG_RELATIONS)),
        trackFile(fetchCatalogFile(STORAGE_CATALOG_FUNCTIONS)),
    ]);

    const scripts: ScriptData[] = (await Promise.all(index.scripts.map(async script => {
            const sql = await trackFile(fetchBestEffortText(
                httpClient,
                sessionFileUrl(baseUrl, script.name),
                MAX_SCRIPT_BYTES,
                signal,
            ), true);
            return sql == null ? null : { name: script.name, sql };
        }))).filter((script): script is ScriptData => script != null);

    totalBytes += optional.reduce((bytes, text) => bytes + (text == null ? 0 : textBytes(text)), 0);
    totalBytes += scripts.reduce((bytes, script) => bytes + textBytes(script.sql), 0);
    const data = (await Promise.all((index.data ?? []).map(async file => {
        const bytes = await trackFile(fetchBestEffortBytes(httpClient,
            new URL(`${STORAGE_ATTACHMENTS_FOLDER}/${encodeURIComponent(file.name)}`, baseUrl), MAX_TOTAL_BYTES, signal));
        return bytes == null ? null : { name: file.name, bytes };
    }))).filter((file): file is DataFileData => file != null);
    totalBytes += data.reduce((size, file) => size + file.bytes.byteLength, 0);
    // Optional files are loaded only while the session remains within the total budget. The
    // manifest is the sole required file, so an oversized optional tree degrades to metadata only.
    const includeOptionalFiles = totalBytes <= MAX_TOTAL_BYTES;

    const bundle: SessionBundle = {
        session: {
            ...session,
            metadata: {
                ...session.metadata,
                originType: 'HTTP',
                originalHttpUrl: manifestUrl.toString(),
            },
        },
        schemaSql: includeOptionalFiles ? optional[0] : null,
        functionsSql: includeOptionalFiles ? optional[1] : null,
        scripts: includeOptionalFiles ? scripts : [],
        data: includeOptionalFiles ? data : [],
    };
    const loadedScriptCount = bundle.scripts.length;
    return {
        bundle,
        indexedScriptCount,
        loadedScriptCount,
        incomplete: !parsedIndex.valid || !includeOptionalFiles || loadedScriptCount !== indexedScriptCount
            || data.length !== (index.data?.length ?? 0),
    };
}

function validateManifestUrl(url: URL): void {
    const isPublicHttps = url.protocol === 'https:';
    const isBundledSession = url.protocol === 'app:' && url.hostname === 'bundle' && !url.port;
    const isDevelopmentLoopback = process.env.DASHQL_BUILD_MODE === 'development'
        && url.protocol === 'http:'
        && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    if ((!isPublicHttps && !isBundledSession && !isDevelopmentLoopback) || url.username || url.password || url.hash) {
        throw new Error('Session URL must be public HTTPS, development loopback HTTP, or a bundled app URL without credentials or a fragment');
    }
    const name = url.pathname.split('/').pop();
    if (name !== STORAGE_SESSION_FILE) {
        throw new Error(`Remote session URL must end in ${STORAGE_SESSION_FILE}`);
    }
}

function parseSession(text: string): SessionData {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`Invalid remote session: invalid ${STORAGE_SESSION_FILE}`);
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Invalid remote session: invalid ${STORAGE_SESSION_FILE}`);
    }
    const session = parsed as SessionData;
    const validation = validateSessionData(session);
    if (!validation.ok) {
        throw new Error(
            `Invalid remote session: invalid ${STORAGE_SESSION_FILE}: ${describeSessionValidationError(validation.error)}`,
        );
    }
    return session;
}

function parseSessionIndex(text: string | null): { index: SessionIndexData; valid: boolean } {
    if (text == null) return { index: { scripts: [] }, valid: false };
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { index: { scripts: [] }, valid: false };
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.scripts)) {
        return { index: { scripts: [] }, valid: false };
    }

    const scripts: SessionIndexScript[] = [];
    const scriptNames = new Set<string>();
    let scriptCount = 0;
    let valid = true;
    for (const script of parsed.scripts) {
        if (scriptCount >= MAX_SCRIPTS) {
            valid = false;
            break;
        }
        if (!isPlainObject(script)
            || !isSafeName(script.name)
            || !script.name.toLowerCase().endsWith('.sql')
            || destinationKey(script.name) === destinationKey('dashql-draft.sql')) {
            valid = false;
            continue;
        }
        const scriptKey = destinationKey(script.name);
        if (scriptNames.has(scriptKey)) {
            valid = false;
            continue;
        }
        scriptNames.add(scriptKey);
        scripts.push({ name: script.name.normalize('NFC') });
        scriptCount += 1;
    }
    const data: SessionIndexScript[] = [];
    const dataNames = new Set<string>();
    if (parsed.data != null && !Array.isArray(parsed.data)) valid = false;
    if (Array.isArray(parsed.data)) {
        for (const file of parsed.data) {
            if (data.length >= MAX_SCRIPTS) { valid = false; break; }
            if (!isPlainObject(file) || !isSafeName(file.name) || dataNames.has(destinationKey(file.name))) {
                valid = false;
                continue;
            }
            dataNames.add(destinationKey(file.name));
            data.push({ name: file.name.normalize('NFC') });
        }
    }
    data.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { index: { scripts, data }, valid };
}

async function fetchBestEffortBytes(
    httpClient: HttpClient, url: URL, maxBytes: number, signal?: AbortSignal,
): Promise<Uint8Array | null> {
    try {
        const response = await httpClient.fetch(url, { method: 'GET', credentials: 'omit', signal });
        if (response.status < 200 || response.status >= 300) return null;
        const declaredSize = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredSize) && declaredSize > maxBytes) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        return bytes.byteLength > maxBytes ? null : bytes;
    } catch (error) {
        if (signal?.aborted || (error as Error)?.name === 'AbortError') throw error;
        return null;
    }
}

function sessionFileUrl(baseUrl: URL, scriptName: string): URL {
    return new URL(
        `${STORAGE_SCRIPTS_FOLDER}/${encodeURIComponent(scriptName)}`,
        baseUrl,
    );
}

async function fetchRequiredText(
    httpClient: HttpClient,
    url: URL,
    label: string,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<string> {
    const response = await httpClient.fetch(url, { method: 'GET', credentials: 'omit', signal });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to fetch remote session file ${label}: HTTP ${response.status}`);
    }
    return await readLimitedText(response, label, maxBytes);
}

async function fetchBestEffortText(
    httpClient: HttpClient,
    url: URL,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<string | null> {
    try {
        const response = await httpClient.fetch(url, { method: 'GET', credentials: 'omit', signal });
        if (response.status < 200 || response.status >= 300) return null;
        return await readLimitedText(response, url.pathname, maxBytes);
    } catch (error) {
        if (signal?.aborted || (error as Error)?.name === 'AbortError') throw error;
        return null;
    }
}

async function readLimitedText(response: HttpFetchResult, label: string, maxBytes: number): Promise<string> {
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        throw new Error(`Remote session file ${label} exceeds the maximum size`);
    }
    const text = await response.text();
    if (textBytes(text) > maxBytes) {
        throw new Error(`Remote session file ${label} exceeds the maximum size`);
    }
    return text;
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeName(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 255
        && value !== '.'
        && value !== '..'
        && !value.includes('/')
        && !value.includes('\\')
        && !value.includes('\0');
}

function destinationKey(value: string): string {
    return value.normalize('NFC').toLowerCase();
}

function textBytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}
