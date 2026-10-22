import type {
    AppSettings,
    ConnectionEntry,
    DataFile,
    CachedQueryResult,
    SessionData,
    SessionEntry,
    ScriptData,
    StorageBackend,
    StorageManifest,
} from './storage_backend.js';
import { StorageBackendType, validateDataFileName } from './storage_backend.js';
import type { CacheFileStat } from './query_result_cache_eviction.js';
import { SESSION_FORMAT_VERSION } from '../../../migration/versions.js';

export class SessionTestBackend implements StorageBackend {
    readonly sessions = new Map<string, SessionData>();
    readonly schemas = new Map<string, string>();
    readonly catalogChanges = new Map<string, string>();
    readonly functions = new Map<string, string>();
    readonly scripts = new Map<string, Map<string, string>>();
    readonly data = new Map<string, Map<string, Uint8Array>>();
    readonly calls: string[] = [];
    appSettings: AppSettings | null = null;
    /// The connections of the manifest, undefined before the connections were migrated
    connections: ConnectionEntry[] | undefined = undefined;
    /// The files of the connections, keyed by `<connectionId>/<fileName>`
    readonly connectionFiles = new Map<string, string>();

    constructor(private readonly type = StorageBackendType.OPFS) {}

    getBackendType(): StorageBackendType { return this.type; }
    async listSessions(): Promise<SessionEntry[]> { return [...this.sessions.keys()].map(path => ({ path })); }
    async loadAppSettings(): Promise<AppSettings | null> { return this.appSettings; }
    async saveAppSettings(settings: AppSettings): Promise<void> { this.appSettings = settings; }
    async loadManifest(): Promise<StorageManifest> {
        return {
            sessions: await this.listSessions(),
            ...(this.appSettings ? { appSettings: this.appSettings } : {}),
            ...(this.connections ? { connections: structuredClone(this.connections) } : {}),
        };
    }
    async updateConnections(update: (connections: ConnectionEntry[] | undefined) => ConnectionEntry[] | null): Promise<void> {
        const next = update(this.connections ? structuredClone(this.connections) : undefined);
        if (next != null) {
            this.calls.push('connections');
            this.connections = next;
        }
    }
    async loadConnectionFile(connectionId: string, fileName: string): Promise<string | null> {
        return this.connectionFiles.get(`${connectionId}/${fileName}`) ?? null;
    }
    async saveConnectionFile(connectionId: string, fileName: string, text: string): Promise<void> {
        this.calls.push(`connection-file:${connectionId}/${fileName}`);
        this.connectionFiles.set(`${connectionId}/${fileName}`, text);
    }
    async deleteConnectionFiles(connectionId: string): Promise<void> {
        for (const key of [...this.connectionFiles.keys()]) {
            if (key.startsWith(`${connectionId}/`)) this.connectionFiles.delete(key);
        }
    }
    async loadSession(sessionId: string): Promise<SessionData> {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error(`No session ${sessionId}`);
        return session;
    }
    async saveSessionManifest(sessionId: string, data: SessionData): Promise<void> {
        this.calls.push(`manifest:${sessionId}`);
        this.sessions.set(sessionId, data);
    }
    async deleteSession(sessionId: string): Promise<void> {
        this.calls.push(`delete-session:${sessionId}`);
        this.sessions.delete(sessionId);
        this.schemas.delete(sessionId);
        this.catalogChanges.delete(sessionId);
        this.functions.delete(sessionId);
        this.scripts.delete(sessionId);
        this.data.delete(sessionId);
    }
    async loadSessionSchema(sessionId: string): Promise<string | null> { return this.schemas.get(sessionId) ?? null; }
    async saveSessionSchema(sessionId: string, sql: string): Promise<void> {
        this.calls.push(`schema:${sessionId}`);
        this.schemas.set(sessionId, sql);
    }
    async loadSessionCatalogChanges(sessionId: string): Promise<string | null> { return this.catalogChanges.get(sessionId) ?? null; }
    async saveSessionCatalogChanges(sessionId: string, sql: string): Promise<void> {
        this.calls.push(`catalog-changes:${sessionId}`);
        this.catalogChanges.set(sessionId, sql);
    }
    async loadSessionFunctions(sessionId: string): Promise<string | null> { return this.functions.get(sessionId) ?? null; }
    async saveSessionFunctions(sessionId: string, sql: string): Promise<void> {
        this.calls.push(`functions:${sessionId}`);
        this.functions.set(sessionId, sql);
    }
    async loadScripts(sessionId: string): Promise<ScriptData[]> {
        return [...(this.scripts.get(sessionId) ?? new Map())]
            .map(([name, sql]) => ({ name, sql }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }
    async loadScript(sessionId: string, scriptName: string): Promise<ScriptData> {
        const sql = this.scripts.get(sessionId)?.get(scriptName);
        if (sql == null) throw new Error(`Script not found: ${scriptName}`);
        return { name: scriptName, sql };
    }
    async saveScript(sessionId: string, scriptName: string, sql: string): Promise<void> {
        this.calls.push(`write:${sessionId}/${scriptName}=${sql}`);
        const scripts = this.scripts.get(sessionId) ?? new Map<string, string>();
        scripts.set(scriptName, sql);
        this.scripts.set(sessionId, scripts);
    }
    async deleteScript(sessionId: string, scriptName: string): Promise<void> {
        this.calls.push(`delete:${sessionId}/${scriptName}`);
        this.scripts.get(sessionId)?.delete(scriptName);
    }
    async renameScript(sessionId: string, oldScriptName: string, newScriptName: string): Promise<void> {
        this.calls.push(`rename:${sessionId}/${oldScriptName}->${newScriptName}`);
        const scripts = this.scripts.get(sessionId);
        if (!scripts?.has(oldScriptName)) return;
        const sql = scripts.get(oldScriptName)!;
        scripts.delete(oldScriptName);
        scripts.set(newScriptName, sql);
    }
    async loadQueryResultCache(): Promise<CachedQueryResult | null> { return null; }
    async listDataFiles(sessionId: string): Promise<DataFile[]> {
        return [...(this.data.get(sessionId) ?? new Map<string, Uint8Array>())]
            .map(([name, bytes]) => ({ name, sizeBytes: bytes.byteLength }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }
    async loadDataFile(sessionId: string, name: string): Promise<Uint8Array> {
        validateDataFileName(name);
        const bytes = this.data.get(sessionId)?.get(name);
        if (!bytes) throw new Error(`Data file not found: ${name}`);
        return bytes.slice();
    }
    async saveDataFile(sessionId: string, name: string, content: Uint8Array | Blob): Promise<void> {
        validateDataFileName(name);
        const data = this.data.get(sessionId) ?? new Map<string, Uint8Array>();
        const bytes = content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : content;
        data.set(name, bytes.slice());
        this.data.set(sessionId, data);
    }
    async deleteDataFile(sessionId: string, name: string): Promise<void> {
        validateDataFileName(name);
        this.data.get(sessionId)?.delete(name);
    }
    async renameDataFile(sessionId: string, oldName: string, newName: string): Promise<void> {
        validateDataFileName(oldName);
        validateDataFileName(newName);
        const data = this.data.get(sessionId);
        if (!data?.has(oldName) || oldName === newName) return;
        data.set(newName, data.get(oldName)!);
        data.delete(oldName);
    }
    async touchQueryResultCacheAccess(): Promise<void> {}
    async saveQueryResultCache(): Promise<void> {}
    async listQueryResultCache(): Promise<CacheFileStat[]> { return []; }
    async hasCachedQueryResult(): Promise<boolean> { return false; }
    async deleteQueryResultCache(): Promise<void> {}
}

export const TEST_SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const TEST_DATABASE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export function testSession(overrides: Partial<SessionData> = {}): SessionData {
    return {
        formatVersion: SESSION_FORMAT_VERSION,
        sessionId: TEST_SESSION_ID,
        name: 'V2 Session',
        mainDatabase: { databaseId: TEST_DATABASE_ID, params: { hyper: {} } as any },
        attachedDatabases: [],
        metadata: {},
        ...overrides,
    };
}
