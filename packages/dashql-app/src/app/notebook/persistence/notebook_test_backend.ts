import type {
    AppSettings,
    ConnectionEntry,
    DataFile,
    CachedQueryResult,
    NotebookData,
    NotebookEntry,
    ScriptData,
    StorageBackend,
    StorageManifest,
} from './storage_backend.js';
import { StorageBackendType, validateDataFileName } from './storage_backend.js';
import type { CacheFileStat } from './query_result_cache_eviction.js';

export class NotebookTestBackend implements StorageBackend {
    readonly notebooks = new Map<string, NotebookData>();
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
    async listNotebooks(): Promise<NotebookEntry[]> { return [...this.notebooks.keys()].map(path => ({ path })); }
    async loadAppSettings(): Promise<AppSettings | null> { return this.appSettings; }
    async saveAppSettings(settings: AppSettings): Promise<void> { this.appSettings = settings; }
    async loadManifest(): Promise<StorageManifest> {
        return {
            notebooks: await this.listNotebooks(),
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
    async loadNotebook(notebookId: string): Promise<NotebookData> {
        const notebook = this.notebooks.get(notebookId);
        if (!notebook) throw new Error(`No notebook ${notebookId}`);
        return notebook;
    }
    async saveNotebookManifest(notebookId: string, data: NotebookData): Promise<void> {
        this.calls.push(`manifest:${notebookId}`);
        this.notebooks.set(notebookId, data);
    }
    async deleteNotebook(notebookId: string): Promise<void> {
        this.calls.push(`delete-notebook:${notebookId}`);
        this.notebooks.delete(notebookId);
        this.schemas.delete(notebookId);
        this.catalogChanges.delete(notebookId);
        this.functions.delete(notebookId);
        this.scripts.delete(notebookId);
        this.data.delete(notebookId);
    }
    async loadNotebookSchema(notebookId: string): Promise<string | null> { return this.schemas.get(notebookId) ?? null; }
    async saveNotebookSchema(notebookId: string, sql: string): Promise<void> {
        this.calls.push(`schema:${notebookId}`);
        this.schemas.set(notebookId, sql);
    }
    async loadNotebookCatalogChanges(notebookId: string): Promise<string | null> { return this.catalogChanges.get(notebookId) ?? null; }
    async saveNotebookCatalogChanges(notebookId: string, sql: string): Promise<void> {
        this.calls.push(`catalog-changes:${notebookId}`);
        this.catalogChanges.set(notebookId, sql);
    }
    async loadNotebookFunctions(notebookId: string): Promise<string | null> { return this.functions.get(notebookId) ?? null; }
    async saveNotebookFunctions(notebookId: string, sql: string): Promise<void> {
        this.calls.push(`functions:${notebookId}`);
        this.functions.set(notebookId, sql);
    }
    async loadScripts(notebookId: string): Promise<ScriptData[]> {
        return [...(this.scripts.get(notebookId) ?? new Map())]
            .map(([name, sql]) => ({ name, sql }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }
    async loadScript(notebookId: string, scriptName: string): Promise<ScriptData> {
        const sql = this.scripts.get(notebookId)?.get(scriptName);
        if (sql == null) throw new Error(`Script not found: ${scriptName}`);
        return { name: scriptName, sql };
    }
    async saveScript(notebookId: string, scriptName: string, sql: string): Promise<void> {
        this.calls.push(`write:${notebookId}/${scriptName}=${sql}`);
        const scripts = this.scripts.get(notebookId) ?? new Map<string, string>();
        scripts.set(scriptName, sql);
        this.scripts.set(notebookId, scripts);
    }
    async deleteScript(notebookId: string, scriptName: string): Promise<void> {
        this.calls.push(`delete:${notebookId}/${scriptName}`);
        this.scripts.get(notebookId)?.delete(scriptName);
    }
    async renameScript(notebookId: string, oldScriptName: string, newScriptName: string): Promise<void> {
        this.calls.push(`rename:${notebookId}/${oldScriptName}->${newScriptName}`);
        const scripts = this.scripts.get(notebookId);
        if (!scripts?.has(oldScriptName)) return;
        const sql = scripts.get(oldScriptName)!;
        scripts.delete(oldScriptName);
        scripts.set(newScriptName, sql);
    }
    async loadQueryResultCache(): Promise<CachedQueryResult | null> { return null; }
    async listDataFiles(notebookId: string): Promise<DataFile[]> {
        return [...(this.data.get(notebookId) ?? new Map<string, Uint8Array>())]
            .map(([name, bytes]) => ({ name, sizeBytes: bytes.byteLength }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }
    async loadDataFile(notebookId: string, name: string): Promise<Uint8Array> {
        validateDataFileName(name);
        const bytes = this.data.get(notebookId)?.get(name);
        if (!bytes) throw new Error(`Data file not found: ${name}`);
        return bytes.slice();
    }
    async saveDataFile(notebookId: string, name: string, content: Uint8Array | Blob): Promise<void> {
        validateDataFileName(name);
        const data = this.data.get(notebookId) ?? new Map<string, Uint8Array>();
        const bytes = content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : content;
        data.set(name, bytes.slice());
        this.data.set(notebookId, data);
    }
    async deleteDataFile(notebookId: string, name: string): Promise<void> {
        validateDataFileName(name);
        this.data.get(notebookId)?.delete(name);
    }
    async renameDataFile(notebookId: string, oldName: string, newName: string): Promise<void> {
        validateDataFileName(oldName);
        validateDataFileName(newName);
        const data = this.data.get(notebookId);
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

export const TEST_NOTEBOOK_ID = '11111111-2222-4333-8444-555555555555';
export const TEST_DATABASE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export function testNotebook(overrides: Partial<NotebookData> = {}): NotebookData {
    return {
        formatVersion: 2,
        notebookId: TEST_NOTEBOOK_ID,
        name: 'V2 Notebook',
        mainDatabase: { databaseId: TEST_DATABASE_ID, params: { hyper: {} } as any },
        attachedDatabases: [],
        metadata: {},
        ...overrides,
    };
}
