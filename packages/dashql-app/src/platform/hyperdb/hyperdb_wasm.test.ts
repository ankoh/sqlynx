// @vitest-environment node
import * as arrow from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import {
    HyperDB,
    type HyperDBEngineClient,
    type HyperDBResult,
} from './hyperdb_wasm.js';

function handle(value: number): HyperDBResult {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, value, true);
    return { state: 'ok', payload };
}

function ipc(table: arrow.Table): Uint8Array {
    return arrow.tableToIPC(table, 'stream');
}

class FakeHyperDBEngineClient implements HyperDBEngineClient {
    readonly calls: string[] = [];
    readonly queryResults = new Map<string, Uint8Array>();
    readonly temporaryFiles = new Map<string, Uint8Array>();
    readonly externalFiles = new Map<string, { url: string; size: number }>();
    readonly externalDirectories = new Map<string, { handle: FileSystemDirectoryHandle; mode: 'read' | 'readwrite' }>();
    readonly insertedTables = new Map<string, arrow.Table>();

    connectCount = 0;
    disconnectCount = 0;
    createDatabaseCount = 0;
    openDatabaseCount = 0;
    checkpointDatabaseCount = 0;
    dropDatabaseCount = 0;
    attachDatabaseCount = 0;
    detachDatabaseCount = 0;
    terminateCount = 0;
    activeOperationCount = 0;
    maximumActiveOperationCount = 0;
    failStartQuery = false;
    failExternalFileRemoval = false;

    private nextConnection = 7;
    private nextQuery = 100;
    private nextFile = 1;
    private readonly queries = new Map<number, HyperDBResult[]>();

    ready(): Promise<void> {
        this.calls.push('ready');
        return Promise.resolve();
    }

    initialize(settings: string): Promise<HyperDBResult> {
        this.calls.push(`initialize:${settings}`);
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    connect(): Promise<HyperDBResult> {
        const connection = this.nextConnection++;
        this.calls.push(`connect:${connection}`);
        this.connectCount++;
        return Promise.resolve(handle(connection));
    }

    disconnect(connection: number): Promise<HyperDBResult> {
        this.calls.push(`disconnect:${connection}`);
        this.disconnectCount++;
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    createDatabase(databaseName: string, persistent: boolean): Promise<HyperDBResult> {
        this.calls.push(`create-database:${databaseName}:${persistent}`);
        this.createDatabaseCount++;
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    openDatabase(databaseName: string): Promise<HyperDBResult> {
        this.calls.push(`open-database:${databaseName}`);
        this.openDatabaseCount++;
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    listDatabases(): Promise<HyperDBResult> {
        const payload = new Uint8Array(4);
        new DataView(payload.buffer).setUint32(0, 0, true);
        return Promise.resolve({ state: 'ok', payload });
    }

    checkpointDatabase(databaseName: string): Promise<HyperDBResult> {
        this.calls.push(`checkpoint-database:${databaseName}`);
        this.checkpointDatabaseCount++;
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    dropDatabase(databaseName: string): Promise<HyperDBResult> {
        this.calls.push(`drop-database:${databaseName}`);
        this.dropDatabaseCount++;
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    attachDatabase(connection: number, databaseName: string, alias: string): Promise<HyperDBResult> {
        this.calls.push(`attach:${connection}:${databaseName}:${alias}`);
        this.attachDatabaseCount++;
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    detachDatabase(connection: number, alias: string): Promise<HyperDBResult> {
        this.calls.push(`detach:${connection}:${alias}`);
        this.detachDatabaseCount++;
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    startQuery(connection: number, sql: string): Promise<HyperDBResult> {
        if (this.failStartQuery) {
            return Promise.resolve({ state: 'busy', error: 'start failed' });
        }
        this.beginOperation();
        this.calls.push(`query:${connection}:${sql}`);
        const query = this.nextQuery++;
        const result = this.queryResults.get(sql);
        this.queries.set(query, result
            ? [{ state: 'chunk', payload: result }, { state: 'done' }]
            : [{ state: 'error', error: `unexpected query: ${sql}` }]);
        return Promise.resolve(handle(query));
    }

    insertArrowIPCFromPath(
        connection: number,
        path: string,
        name: string,
        schema: string | null,
        create: boolean,
        internal: boolean,
    ): Promise<HyperDBResult> {
        this.beginOperation();
        this.calls.push(`insert:${connection}:${path}:${schema ?? ''}:${name}:${create}:${internal}`);
        const query = this.nextQuery++;
        const bytes = this.temporaryFiles.get(path);
        if (!bytes) {
            this.queries.set(query, [{ state: 'error', error: `missing temporary file: ${path}` }]);
        } else {
            const table = arrow.tableFromIPC(bytes);
            const key = schema ? `${schema}.${name}` : name;
            if (create) {
                this.insertedTables.set(key, table);
            } else {
                const previous = this.insertedTables.get(key);
                if (!previous) {
                    this.queries.set(query, [{ state: 'error', error: `missing table: ${key}` }]);
                    return Promise.resolve(handle(query));
                }
                this.insertedTables.set(key, previous.concat(table));
            }
            this.queries.set(query, [{ state: 'done' }]);
        }
        return Promise.resolve(handle(query));
    }

    createTemporaryFile(bytes: Uint8Array): Promise<HyperDBResult> {
        const path = `/tmp/hyperdb/test-${this.nextFile++}.arrows`;
        this.calls.push(`create-file:${path}`);
        this.temporaryFiles.set(path, bytes.slice());
        return Promise.resolve({ state: 'ok', payload: new TextEncoder().encode(path) });
    }

    removeFile(path: string): Promise<HyperDBResult> {
        this.calls.push(`remove-file:${path}`);
        this.temporaryFiles.delete(path);
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    registerExternalFile(name: string, url: string, size: number): Promise<HyperDBResult> {
        const path = `/mnt/external/${this.nextFile++}/${name}`;
        this.calls.push(`register-external-file:${path}:${url}:${size}`);
        this.externalFiles.set(path, { url, size });
        return Promise.resolve({ state: 'ok', payload: new TextEncoder().encode(path) });
    }

    registerExternalDirectory(handle: FileSystemDirectoryHandle, mode: 'read' | 'readwrite'): Promise<HyperDBResult> {
        const path = `/mnt/external/${this.nextFile++}/${handle.name}`;
        this.calls.push(`register-external-directory:${path}:${mode}`);
        this.externalDirectories.set(path, { handle, mode });
        return Promise.resolve({ state: 'ok', payload: new TextEncoder().encode(path) });
    }

    removeExternalRegistration(path: string): Promise<HyperDBResult> {
        this.calls.push(`remove-external-registration:${path}`);
        if (this.failExternalFileRemoval) return Promise.resolve({ state: 'busy', error: 'External file has active readers' });
        this.externalFiles.delete(path);
        this.externalDirectories.delete(path);
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    pollQuery(query: number): Promise<HyperDBResult> {
        this.calls.push(`poll:${query}`);
        const results = this.queries.get(query);
        return Promise.resolve(results?.shift() ?? { state: 'error', error: `missing query: ${query}` });
    }

    cancelQuery(query: number): Promise<HyperDBResult> {
        this.calls.push(`cancel:${query}`);
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    finishQuery(query: number): Promise<HyperDBResult> {
        this.calls.push(`finish:${query}`);
        this.queries.delete(query);
        this.activeOperationCount--;
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    shutdown(): Promise<HyperDBResult> {
        this.calls.push('shutdown');
        return Promise.resolve({ state: 'ok', payload: new Uint8Array() });
    }

    terminate(): Promise<void> {
        this.calls.push('terminate');
        this.terminateCount++;
        return Promise.resolve();
    }

    private beginOperation(): void {
        this.activeOperationCount++;
        this.maximumActiveOperationCount = Math.max(this.maximumActiveOperationCount, this.activeOperationCount);
    }
}

function toPlainObjects(table: arrow.Table): Record<string, unknown>[] {
    return table.toArray().map(row => Object.fromEntries(Object.keys(row).map(key => [key, row[key]])));
}

describe('HyperDB embedded database adapter', () => {
    it('owns browser object URLs for external files', async () => {
        const client = new FakeHyperDBEngineClient();
        const revoked: string[] = [];
        const database = await HyperDB.create(client, undefined, {
            createObjectURL: () => 'blob:test-file',
            revokeObjectURL: url => { revoked.push(url); },
        });

        const path = await database.registerExternalFile('data.csv', new Blob(['id\n1\n']));
        expect(path).toBe('/mnt/external/1/data.csv');
        expect(client.externalFiles.get(path)).toEqual({ url: 'blob:test-file', size: 5 });
        expect(revoked).toEqual([]);

        await database.removeExternalFile(path);
        expect(revoked).toEqual(['blob:test-file']);
        await database.terminate();
    });

    it('registers and removes browser directories using the requested mode', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const handle = { kind: 'directory', name: 'exports' } as FileSystemDirectoryHandle;

        const path = await database.registerExternalDirectory(handle, 'readwrite');

        expect(path).toBe('/mnt/external/1/exports');
        expect(client.externalDirectories.get(path)).toEqual({ handle, mode: 'readwrite' });
        await database.removeExternalDirectory(path);
        expect(client.externalDirectories.has(path)).toBe(false);
        await database.terminate();
    });

    it('cleans external directories during termination', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const path = await database.registerExternalDirectory(
            { kind: 'directory', name: 'exports' } as FileSystemDirectoryHandle,
            'read',
        );

        await database.terminate();

        expect(client.calls).toContain(`remove-external-registration:${path}`);
        expect(client.externalDirectories.has(path)).toBe(false);
    });

    it('retains object URLs when external-file removal is busy', async () => {
        const client = new FakeHyperDBEngineClient();
        const revoked: string[] = [];
        const database = await HyperDB.create(client, undefined, {
            createObjectURL: () => 'blob:busy-file',
            revokeObjectURL: url => { revoked.push(url); },
        });
        const path = await database.registerExternalFile('data.csv', new Blob(['id\n1\n']));
        client.failExternalFileRemoval = true;

        await expect(database.removeExternalFile(path)).rejects.toThrow('External file has active readers');
        expect(revoked).toEqual([]);

        client.failExternalFileRemoval = false;
        await database.terminate();
        expect(revoked).toEqual(['blob:busy-file']);
    });

    it('cleans external files during wrapper termination with a shared client', async () => {
        const client = new FakeHyperDBEngineClient();
        const revoked: string[] = [];
        const database = await HyperDB.create(client, undefined, {
            terminateClient: false,
            createObjectURL: () => 'blob:shared-file',
            revokeObjectURL: url => { revoked.push(url); },
        });
        const path = await database.registerExternalFile('data.csv', new Blob(['id\n1\n']));

        await database.terminate();

        expect(client.calls).toContain(`remove-external-registration:${path}`);
        expect(revoked).toEqual(['blob:shared-file']);
        expect(client.terminateCount).toBe(0);
    });

    it('attaches the compute database to each physical connection', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const first = await database.connect({ defaultDatabase: '__dashql_compute' });
        const second = await database.connect();

        await first.close();
        const third = await database.connect();

        expect(client.connectCount).toBe(3);
        expect(client.disconnectCount).toBe(1);
        expect(client.createDatabaseCount).toBe(2);
        expect(client.attachDatabaseCount).toBe(3);
        expect(client.calls).toContain('attach:7:__dashql_compute:__dashql_compute');

        await second.close();
        await third.close();
        await database.terminate();

        expect(client.disconnectCount).toBe(3);
        expect(client.detachDatabaseCount).toBe(3);
        expect(client.calls).toContain('detach:7:__dashql_compute');
        expect(client.dropDatabaseCount).toBe(2);
        expect(client.terminateCount).toBe(1);
        expect(client.calls).toContain('shutdown');
    });

    it('initializes the engine settings before creating the shared database', async () => {
        const client = new FakeHyperDBEngineClient();
        await HyperDB.create(client, {
            'global.experimental_view_creation': true,
            'global.experimental_persisted_view_creation': true,
            'global.http_location_allowlist': ['*'],
        });

        expect(client.calls).toEqual([
            'ready',
            'initialize:{"global.experimental_view_creation":true,"global.experimental_persisted_view_creation":true,"global.http_location_allowlist":["*"]}',
            'create-database:__dashql_compute:false',
            'create-database:hyper:false',
        ]);
    });

    it('serializes global external table settings for the engine', async () => {
        const client = new FakeHyperDBEngineClient();
        await HyperDB.create(client, {
            'global.experimental_external_metaquery': 1,
            'global.experimental_persisted_external_tables': 1,
        });

        expect(client.calls).toContain(
            'initialize:{"global.experimental_external_metaquery":1,"global.experimental_persisted_external_tables":1}',
        );
    });

    it('attaches hyper as the separate user-facing database', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);

        const connection = await database.connect({ defaultDatabase: 'hyper' });

        expect(client.calls).toContain('attach:7:hyper:hyper');

        await connection.close();
        await database.terminate();

        expect(client.calls).toContain('detach:7:hyper');
    });

    it('creates shared Arrow tables in the attached database', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const writer = await database.connect();

        await writer.insertArrowTable(arrow.tableFromArrays({
            id: new Int32Array([1, 2, 3]),
            label: ['alpha', 'beta', 'gamma'],
        }), { name: '__frame', create: true });
        await writer.close();

        const inserted = client.insertedTables.get('public.__frame');
        expect(inserted).toBeDefined();
        client.queryResults.set('SELECT * FROM "__frame"', ipc(inserted!));

        const reader = await database.connect();
        const result = await reader.query('SELECT * FROM "__frame"');

        expect(toPlainObjects(result)).toEqual([
            { id: 1, label: 'alpha' },
            { id: 2, label: 'beta' },
            { id: 3, label: 'gamma' },
        ]);
        expect(client.calls).toContain('insert:7:/tmp/hyperdb/test-1.arrows:public:__frame:true:true');
        expect(client.connectCount).toBe(2);

        await reader.close();
        await database.terminate();
    });

    it('uses Arrow IPC from DashQL Arrow and materializes dictionary columns', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const connection = await database.connect();

        await connection.insertArrowTable(arrow.tableFromArrays({ label: ['first', 'second'] }), {
            name: 'labels',
            create: true,
        });

        const inserted = client.insertedTables.get('public.labels');
        expect(inserted?.schema.fields[0]?.type.toString()).toBe('Utf8');
        expect(client.temporaryFiles.size).toBe(0);

        await connection.close();
        await database.terminate();
    });

    it('preserves schema and append options while cleaning up staged IPC', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const connection = await database.connect();

        await connection.insertArrowTable(arrow.tableFromArrays({ value: new Int32Array([1]) }), {
            schema: 'pg_temp',
            name: 'values',
        });
        await connection.insertArrowTable(arrow.tableFromArrays({ value: new Int32Array([2]) }), {
            schema: 'pg_temp',
            name: 'values',
            create: false,
        });

        expect(toPlainObjects(client.insertedTables.get('pg_temp.values')!)).toEqual([
            { value: 1 },
            { value: 2 },
        ]);
        expect(client.calls).toContain('insert:7:/tmp/hyperdb/test-1.arrows:pg_temp:values:true:true');
        expect(client.calls).toContain('insert:7:/tmp/hyperdb/test-2.arrows:pg_temp:values:false:true');
        expect(client.temporaryFiles.size).toBe(0);

        await connection.close();
        await database.terminate();
    });

    it('creates derived relations in the attached database with quoted names', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const connection = await database.connect();
        client.queryResults.set(
            'CREATE TABLE "derived""rows" AS SELECT 1',
            ipc(arrow.tableFromArrays({})),
        );

        await connection.createTableAs('derived"rows', 'SELECT 1');

        expect(client.calls).toContain('query:7:CREATE TABLE "derived""rows" AS SELECT 1');
        await connection.close();
        await database.terminate();
    });

    it('submits operations through separate physical connections without a global lock', async () => {
        const client = new FakeHyperDBEngineClient();
        const firstResult = ipc(arrow.tableFromArrays({ value: new Int32Array([1]) }));
        const secondResult = ipc(arrow.tableFromArrays({ value: new Int32Array([2]) }));
        client.queryResults.set('SELECT 1 AS value', firstResult);
        client.queryResults.set('SELECT 2 AS value', secondResult);
        const database = await HyperDB.create(client);
        const first = await database.connect();
        const second = await database.connect();

        const [one, two] = await Promise.all([
            first.query('SELECT 1 AS value'),
            second.query('SELECT 2 AS value'),
        ]);

        expect(toPlainObjects(one)).toEqual([{ value: 1 }]);
        expect(toPlainObjects(two)).toEqual([{ value: 2 }]);
        expect(client.maximumActiveOperationCount).toBe(2);
        expect(client.calls).toContain('query:7:SELECT 1 AS value');
        expect(client.calls).toContain('query:8:SELECT 2 AS value');

        await first.close();
        await second.close();
        await database.terminate();
    });

    it('releases failed queries and leaves other connections usable', async () => {
        const client = new FakeHyperDBEngineClient();
        client.queryResults.set('SELECT 42 AS answer', ipc(arrow.tableFromArrays({ answer: new Int32Array([42]) })));
        const database = await HyperDB.create(client);
        const first = await database.connect();
        const second = await database.connect();

        await expect(first.query('SELECT missing')).rejects.toThrow('unexpected query: SELECT missing');
        await expect(second.query('SELECT 42 AS answer')).resolves.toBeDefined();

        expect(client.activeOperationCount).toBe(0);
        expect(client.calls.filter(call => call.startsWith('finish:'))).toHaveLength(2);

        await first.close();
        await second.close();
        await database.terminate();
    });

    it('leaves a connection usable when starting a query fails', async () => {
        const client = new FakeHyperDBEngineClient();
        client.failStartQuery = true;
        const database = await HyperDB.create(client);
        const first = await database.connect();
        const second = await database.connect();

        await expect(first.query('SELECT 1')).rejects.toThrow('start failed');

        client.failStartQuery = false;
        client.queryResults.set('SELECT 2 AS value', ipc(arrow.tableFromArrays({ value: new Int32Array([2]) })));
        await expect(second.query('SELECT 2 AS value')).resolves.toBeDefined();

        await first.close();
        await second.close();
        await database.terminate();
    });

    it('rejects use of a closed connection after closing its physical session', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const connection = await database.connect();
        await connection.close();

        await expect(connection.query('SELECT 1')).rejects.toThrow('connection is closed');
        expect(client.disconnectCount).toBe(1);

        await database.terminate();
    });
});
