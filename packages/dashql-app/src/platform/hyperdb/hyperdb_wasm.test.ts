// @vitest-environment node
import * as arrow from 'apache-arrow';
import type { MountSource } from 'hyperdb-wasm/raw';
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


    startQuery(connection: number, sql: string): Promise<HyperDBResult> {
        const lifecycleStatement = /^(?:CREATE|DROP|ATTACH|DETACH) DATABASE\b/.test(sql);
        if (lifecycleStatement) {
            this.beginOperation();
            this.calls.push(`query:${connection}:${sql}`);
            const query = this.nextQuery++;
            this.queries.set(query, [{ state: 'done' }]);
            return Promise.resolve(handle(query));
        }
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

    mount(source: MountSource, path: string, mode: 'read' | 'readwrite'): Promise<HyperDBResult> {
        this.calls.push(`mount:${path}:${mode}`);
        if (source.kind === 'browser-file') {
            this.externalFiles.set(path, { url: source.url, size: source.size });
        } else if (source.kind === 'browser-directory') {
            this.externalDirectories.set(path, { handle: source.handle as FileSystemDirectoryHandle, mode });
        }
        return Promise.resolve({ state: 'ok', payload: new TextEncoder().encode(path) });
    }

    unmount(path: string): Promise<HyperDBResult> {
        this.calls.push(`unmount:${path}`);
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
        expect(path).toBe('/mnt/external/data.csv');
        expect(client.calls).toContain(`mount:${path}:read`);
        expect(client.externalFiles.get(path)).toEqual({ url: 'blob:test-file', size: 5 });
        expect(revoked).toEqual([]);

        await database.removeExternalFile(path);
        expect(revoked).toEqual(['blob:test-file']);
        await database.terminate();
    });

    it('registers and removes browser directories at the requested path and mode', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const handle = { kind: 'directory', name: 'exports' } as FileSystemDirectoryHandle;

        const path = await database.registerExternalDirectory(handle, '/mnt/external/exports', 'readwrite');

        expect(path).toBe('/mnt/external/exports');
        expect(client.externalDirectories.get(path)).toEqual({ handle, mode: 'readwrite' });
        await database.removeExternalDirectory(path);
        expect(client.externalDirectories.has(path)).toBe(false);
        await database.terminate();
    });

    it('registers browser directories at a path derived from the directory name', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const handle = { kind: 'directory', name: 'exports' } as FileSystemDirectoryHandle;

        await expect(database.registerExternalDirectory(handle, undefined, 'read'))
            .resolves.toBe('/mnt/external/exports');
        await database.terminate();
    });

    it('rejects invalid browser directory mount paths before sending a request', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const handle = { kind: 'directory', name: 'exports' } as FileSystemDirectoryHandle;

        await expect(database.registerExternalDirectory(handle, '/foo', 'read'))
            .rejects.toThrow('external mount path must be below /mnt/external/');
        expect(client.externalDirectories.size).toBe(0);
        await database.terminate();
    });

    it('sanitizes generated file paths while preserving explicit directory paths', async () => {
        const client = new FakeHyperDBEngineClient();
        const first = await HyperDB.create(client, undefined, { terminateClient: false });
        const second = await HyperDB.create(client, undefined, { terminateClient: false });
        const name = 'a folder/with spaces/'.repeat(20) + 'data.csv';
        const filePath = await first.registerExternalFile(name, new Blob(['1']));
        const directoryPath = await second.registerExternalDirectory(
            { name } as FileSystemDirectoryHandle, '/mnt/external/directory', 'read',
        );
        const anotherPath = await second.registerExternalFile('another.csv', new Blob(['2']));

        expect(directoryPath).toBe('/mnt/external/directory');
        for (const path of [filePath, anotherPath]) {
            expect(path).toMatch(/^\/mnt\/external\/[a-zA-Z0-9._-]+$/);
            expect(new TextEncoder().encode(path.slice('/mnt/external/'.length)).length).toBeLessThanOrEqual(200);
        }
        await first.terminate();
        expect(client.externalFiles.has(anotherPath)).toBe(true);
        expect(client.externalDirectories.has(directoryPath)).toBe(true);
        await second.terminate();
    });

    it('revokes object URLs when mounting fails', async () => {
        const client = new FakeHyperDBEngineClient();
        client.mount = async () => ({ state: 'error', error: 'mount failed' });
        const revoked: string[] = [];
        const database = await HyperDB.create(client, undefined, {
            createObjectURL: () => 'blob:failed-mount',
            revokeObjectURL: url => { revoked.push(url); },
        });

        await expect(database.registerExternalFile('data.csv', new Blob(['1']))).rejects.toThrow('mount failed');
        expect(revoked).toEqual(['blob:failed-mount']);
        await database.terminate();
    });

    it('unmounts files when cancellation arrives during mounting', async () => {
        const client = new FakeHyperDBEngineClient();
        const abort = new AbortController();
        const mount = client.mount.bind(client);
        client.mount = async (...args) => {
            const result = await mount(...args);
            abort.abort();
            return result;
        };
        const revoked: string[] = [];
        const database = await HyperDB.create(client, undefined, {
            createObjectURL: () => 'blob:cancelled-mount',
            revokeObjectURL: url => { revoked.push(url); },
        });

        await expect(database.registerExternalFile('data.csv', new Blob(['1']), undefined, abort.signal))
            .rejects.toThrow('aborted');
        expect(client.externalFiles.size).toBe(0);
        expect(revoked).toEqual(['blob:cancelled-mount']);
        await database.terminate();
    });

    it('cleans external directories during termination', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const path = await database.registerExternalDirectory(
            { kind: 'directory', name: 'exports' } as FileSystemDirectoryHandle, '/mnt/external/exports',
            'read',
        );

        await database.terminate();

        expect(client.calls).toContain(`unmount:${path}`);
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

        expect(client.calls).toContain(`unmount:${path}`);
        expect(revoked).toEqual(['blob:shared-file']);
        expect(client.terminateCount).toBe(0);
    });

    it('opens and closes physical connections', async () => {
        const client = new FakeHyperDBEngineClient();
        const database = await HyperDB.create(client);
        const first = await database.connect();
        const second = await database.connect();

        await first.close();
        const third = await database.connect();

        expect(client.connectCount).toBe(3);
        expect(client.disconnectCount).toBe(1);

        await second.close();
        await third.close();
        await database.terminate();

        expect(client.disconnectCount).toBe(3);
        expect(client.terminateCount).toBe(1);
        expect(client.calls).toContain('shutdown');
    });

    it('initializes the engine settings before opening connections', async () => {
        const client = new FakeHyperDBEngineClient();
        await HyperDB.create(client, {
            'global.experimental_view_creation': true,
            'global.experimental_persisted_view_creation': true,
            'global.http_location_allowlist': ['*'],
        });

        expect(client.calls).toContain(
            'initialize:{"global.experimental_view_creation":true,"global.experimental_persisted_view_creation":true,"global.http_location_allowlist":["*"]}',
        );
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
        expect(client.calls.some(call => /insert:\d+:\/tmp\/hyperdb\/test-1\.arrows:public:__frame:true:true/.test(call))).toBe(true);
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
        expect(client.calls.some(call => /insert:\d+:\/tmp\/hyperdb\/test-1\.arrows:pg_temp:values:true:true/.test(call))).toBe(true);
        expect(client.calls.some(call => /insert:\d+:\/tmp\/hyperdb\/test-2\.arrows:pg_temp:values:false:true/.test(call))).toBe(true);
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

        expect(client.calls.some(call => /query:\d+:CREATE TABLE "derived""rows" AS SELECT 1/.test(call))).toBe(true);
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
        expect(client.calls.some(call => /query:\d+:SELECT 1 AS value/.test(call))).toBe(true);
        expect(client.calls.some(call => /query:\d+:SELECT 2 AS value/.test(call))).toBe(true);

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
