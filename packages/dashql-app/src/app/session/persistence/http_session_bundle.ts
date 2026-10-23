import type { HttpClient, HttpFetchResult } from '../../../platform/http/http_client.js';
import type { DataFileData, ScriptData } from '../../storage/storage_backend.js';
import {
    STORAGE_SESSION_FILE,
    STORAGE_ATTACHMENTS_FOLDER,
    STORAGE_SCRIPTS_FOLDER,
} from '../../storage/storage_backend.js';
import type { SessionBundle } from '../../storage/session_bundle.js';
import { assembleSessionBundle, readSessionBundleHead } from '../../storage/session_bundle.js';
import { type MigrationFolder, OverlayFolder } from '../../../migration/migration_folder.js';
import { LEGACY_SESSION_FILE } from '../../../migration/legacy_links.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface HttpSessionLoadResult {
    /// The loaded session
    bundle: SessionBundle;
    /// The number of scripts that the session file lists
    listedScriptCount: number;
    /// The number of scripts that were loaded
    loadedScriptCount: number;
    /// Were files missing, unusable or over the size budget?
    incomplete: boolean;
}

export type HttpSessionLoadProgress =
    | { phase: 'preparing' }
    | { phase: 'manifest' }
    | { phase: 'listing'; sessionName: string; sessionId: string }
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
    const manifestName = validateManifestUrl(manifestUrl);
    const baseUrl = new URL('./', manifestUrl);
    let totalBytes = 0;

    onProgress?.({ phase: 'manifest' });
    const manifestText = await fetchRequiredText(httpClient, manifestUrl, manifestName, MAX_MANIFEST_BYTES, signal);
    totalBytes += textBytes(manifestText);
    // Sessions published by older versions are migrated in memory
    const folder = new OverlayFolder(new HttpFolder(baseUrl, httpClient, MAX_SCRIPT_BYTES, signal, manifestName, manifestText));
    const head = await readSessionBundleHead(folder, 'Invalid remote session');
    const session = head.session;
    const sessionName = session.name?.trim() || session.metadata.originalFileName || 'Unnamed session';
    totalBytes += head.catalogs.flatMap(catalog => [catalog.relations, catalog.functions])
        .reduce((bytes, text) => bytes + (text == null ? 0 : textBytes(text)), 0);

    onProgress?.({ phase: 'listing', sessionName, sessionId: session.sessionId });
    const listedScripts = session.scripts;
    const listedAttachments = session.attachments;
    const listedScriptCount = listedScripts.length;
    // The manifest and the catalog files of the connections
    const headFileCount = 1 + 2 * session.connections.length;
    const totalFileCount = headFileCount + listedScriptCount + listedAttachments.length;
    let completedFileCount = headFileCount;
    let completedScriptCount = 0;
    const reportFileProgress = () => onProgress?.({
        phase: 'files',
        sessionName,
        sessionId: session.sessionId,
        completedFileCount,
        totalFileCount,
        completedScriptCount,
        totalScriptCount: listedScriptCount,
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

    const scripts: ScriptData[] = (await Promise.all(listedScripts.map(async script => {
            const sql = await trackFile(fetchBestEffortText(
                httpClient,
                sessionFileUrl(baseUrl, script.name),
                MAX_SCRIPT_BYTES,
                signal,
            ), true);
            return sql == null ? null : { name: script.name, sql };
        }))).filter((script): script is ScriptData => script != null);

    totalBytes += scripts.reduce((bytes, script) => bytes + textBytes(script.sql), 0);
    const data = (await Promise.all(listedAttachments.map(async file => {
        const bytes = await trackFile(fetchBestEffortBytes(httpClient,
            new URL(`${STORAGE_ATTACHMENTS_FOLDER}/${encodeURIComponent(file.name)}`, baseUrl), MAX_TOTAL_BYTES, signal));
        return bytes == null ? null : { name: file.name, bytes };
    }))).filter((file): file is DataFileData => file != null);
    totalBytes += data.reduce((size, file) => size + file.bytes.byteLength, 0);
    // Optional files are loaded only while the session remains within the total budget. The
    // manifest is the sole required file, so an oversized optional tree degrades to metadata only.
    const includeOptionalFiles = totalBytes <= MAX_TOTAL_BYTES;

    // Scripts that failed to load are dropped from the list
    const bundle = assembleSessionBundle({
        session: {
            ...session,
            metadata: {
                ...session.metadata,
                originType: 'HTTP',
                originalHttpUrl: manifestUrl.toString(),
            },
        },
        catalogs: includeOptionalFiles ? head.catalogs : [],
    }, includeOptionalFiles ? scripts : [], includeOptionalFiles ? data : []);
    const loadedScriptCount = bundle.scripts.length;
    return {
        bundle,
        listedScriptCount,
        loadedScriptCount,
        incomplete: !head.filesValid || !includeOptionalFiles || loadedScriptCount !== listedScriptCount
            || data.length !== listedAttachments.length,
    };
}

/// The top-level files of a hosted session, fetched when a reader asks for them.
///
/// Each file is fetched at most once, a missing or unreadable file reads as null. The folder is
/// read-only, the session migration changes it through an `OverlayFolder`.
class HttpFolder implements MigrationFolder {
    /// The URL of the session folder
    private readonly baseUrl: URL;
    /// The client that fetches the files
    private readonly httpClient: HttpClient;
    /// The maximum size of a file
    private readonly maxBytes: number;
    /// The signal that aborts the fetches
    private readonly signal: AbortSignal | undefined;
    /// The fetched files by name, null for missing ones
    private readonly files: Map<string, Promise<string | null>>;

    constructor(baseUrl: URL, httpClient: HttpClient, maxBytes: number, signal: AbortSignal | undefined, manifestName: string, manifestText: string) {
        this.baseUrl = baseUrl;
        this.httpClient = httpClient;
        this.maxBytes = maxBytes;
        this.signal = signal;
        this.files = new Map([[manifestName, Promise.resolve(manifestText)]]);
    }

    async exists(name: string): Promise<boolean> {
        return (await this.readText(name)) != null;
    }

    readText(name: string): Promise<string | null> {
        let file = this.files.get(name);
        if (file === undefined) {
            file = fetchBestEffortText(this.httpClient, new URL(name, this.baseUrl), this.maxBytes, this.signal);
            this.files.set(name, file);
        }
        return file;
    }

    async writeText(name: string): Promise<void> {
        throw new Error(`Cannot write ${name} of a remote session`);
    }

    async rename(from: string): Promise<void> {
        throw new Error(`Cannot rename ${from} of a remote session`);
    }

    async remove(name: string): Promise<void> {
        throw new Error(`Cannot remove ${name} of a remote session`);
    }
}

/// Validate the URL of a hosted session, returns the name of the session metadata
function validateManifestUrl(url: URL): string {
    const isPublicHttps = url.protocol === 'https:';
    const isBundledSession = url.protocol === 'app:' && url.hostname === 'bundle' && !url.port;
    const isDevelopmentLoopback = process.env.DASHQL_BUILD_MODE === 'development'
        && url.protocol === 'http:'
        && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    if ((!isPublicHttps && !isBundledSession && !isDevelopmentLoopback) || url.username || url.password || url.hash) {
        throw new Error('Session URL must be public HTTPS, development loopback HTTP, or a bundled app URL without credentials or a fragment');
    }
    // Links of older versions point to the metadata under its older name
    const name = url.pathname.split('/').pop();
    if (name !== STORAGE_SESSION_FILE && name !== LEGACY_SESSION_FILE) {
        throw new Error(`Remote session URL must end in ${STORAGE_SESSION_FILE}`);
    }
    return name;
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




function textBytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}
