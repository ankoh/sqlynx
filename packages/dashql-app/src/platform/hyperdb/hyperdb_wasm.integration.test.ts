import * as arrow from 'apache-arrow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DataFrame, generateTableName } from '../../compute/data_frame.js';
import { WebFile } from '../file/web_file.js';
import { ShellFileRegistry } from '../../shell/shell_files.js';
import { createWebHyperDBClient } from './hyperdb_provider_web.js';
import { HyperDB, type HyperDBEngineClient, type HyperDBResult } from './hyperdb_wasm.js';
import type { OPFSFileImportOptions } from '../database/embedded_database.js';

function toPlainObjects(table: arrow.Table): Record<string, unknown>[] {
    return table.toArray().map(row => Object.fromEntries(Object.keys(row).map(key => [key, row[key]])));
}

function persistentDatabaseName(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '_')}`;
}

async function ignoreCleanupFailure(cleanup: () => Promise<void>): Promise<void> {
    try {
        await cleanup();
    } catch {
        // Preserve the test failure that triggered cleanup.
    }
}

class CountingClient implements HyperDBEngineClient {
    connectCount = 0;
    disconnectCount = 0;
    createDatabaseCount = 0;
    dropDatabaseCount = 0;
    attachDatabaseCount = 0;
    detachDatabaseCount = 0;

    constructor(private readonly client: HyperDBEngineClient) {}

    ready(): Promise<void> {
        return this.client.ready();
    }

    initialize(settings: string): Promise<HyperDBResult> {
        return this.client.initialize(settings);
    }

    connect(): Promise<HyperDBResult> {
        this.connectCount++;
        return this.client.connect();
    }

    disconnect(connection: number): Promise<HyperDBResult> {
        this.disconnectCount++;
        return this.client.disconnect(connection);
    }

    createDatabase(databaseName: string, persistent: boolean): Promise<HyperDBResult> {
        this.createDatabaseCount++;
        return this.client.createDatabase(databaseName, persistent);
    }

    openDatabase(databaseName: string): Promise<HyperDBResult> {
        return this.client.openDatabase(databaseName);
    }

    listDatabases(): Promise<HyperDBResult> {
        return this.client.listDatabases();
    }

    checkpointDatabase(databaseName: string): Promise<HyperDBResult> {
        return this.client.checkpointDatabase(databaseName);
    }

    dropDatabase(databaseName: string): Promise<HyperDBResult> {
        this.dropDatabaseCount++;
        return this.client.dropDatabase(databaseName);
    }

    attachDatabase(connection: number, databaseName: string, alias: string): Promise<HyperDBResult> {
        this.attachDatabaseCount++;
        return this.client.attachDatabase(connection, databaseName, alias);
    }

    detachDatabase(connection: number, alias: string): Promise<HyperDBResult> {
        this.detachDatabaseCount++;
        return this.client.detachDatabase(connection, alias);
    }

    startQuery(connection: number, sql: string): Promise<HyperDBResult> {
        return this.client.startQuery(connection, sql);
    }

    insertArrowIPCFromPath(
        connection: number,
        path: string,
        name: string,
        schema: string | null,
        create: boolean,
        internal: boolean,
    ): Promise<HyperDBResult> {
        return this.client.insertArrowIPCFromPath(connection, path, name, schema, create, internal);
    }

    createTemporaryFile(bytes: Uint8Array): Promise<HyperDBResult> {
        return this.client.createTemporaryFile(bytes);
    }

    removeFile(path: string): Promise<HyperDBResult> {
        return this.client.removeFile(path);
    }

    registerExternalFile(name: string, url: string, size: number): Promise<HyperDBResult> {
        return this.client.registerExternalFile(name, url, size);
    }

    removeExternalRegistration(path: string): Promise<HyperDBResult> {
        return this.client.removeExternalRegistration(path);
    }

    importOPFSFile(path: string, blob: Blob, options?: OPFSFileImportOptions): Promise<void> {
        if (this.client.importOPFSFile == null) throw new Error('importing OPFS files is not supported');
        return this.client.importOPFSFile(path, blob, options);
    }

    prepareOPFSFile(path: string): Promise<void> {
        if (this.client.prepareOPFSFile == null) throw new Error('preparing OPFS files is not supported');
        return this.client.prepareOPFSFile(path);
    }

    writeOPFSFile(path: string, chunk: Uint8Array, offset: number): Promise<void> {
        if (this.client.writeOPFSFile == null) throw new Error('writing OPFS files is not supported');
        return this.client.writeOPFSFile(path, chunk, offset);
    }

    finishOPFSFile(path: string): Promise<void> {
        if (this.client.finishOPFSFile == null) throw new Error('finishing OPFS files is not supported');
        return this.client.finishOPFSFile(path);
    }

    abortOPFSFile(path: string): Promise<void> {
        if (this.client.abortOPFSFile == null) throw new Error('aborting OPFS files is not supported');
        return this.client.abortOPFSFile(path);
    }

    removeOPFSFile(path: string): Promise<void> {
        if (this.client.removeOPFSFile == null) throw new Error('removing OPFS files is not supported');
        return this.client.removeOPFSFile(path);
    }

    pollQuery(query: number): Promise<HyperDBResult> {
        return this.client.pollQuery(query);
    }

    cancelQuery(query: number): Promise<HyperDBResult> {
        return this.client.cancelQuery(query);
    }

    finishQuery(query: number): Promise<HyperDBResult> {
        return this.client.finishQuery(query);
    }

    shutdown(): Promise<HyperDBResult> {
        return this.client.shutdown();
    }

    terminate(): Promise<void> {
        return this.client.terminate();
    }
}

describe('HyperDB embedded database integration', () => {
    let client: CountingClient;
    let engineClient: HyperDBEngineClient;
    let database: HyperDB | null = null;
    let nextDatabase = 1;

    beforeAll(async () => {
        engineClient = globalThis.__DASHQL_TEST_HYPERDB_CLIENT__
            ? await globalThis.__DASHQL_TEST_HYPERDB_CLIENT__()
            : await createWebHyperDBClient();
    });

    beforeEach(async () => {
        client = new CountingClient(engineClient);
        database = await HyperDB.create(client, undefined, {
            databasePrefix: `__dashql_integration_${nextDatabase++}_`,
            terminateClient: false,
        });
    }, 60_000);

    afterEach(async () => {
        await database?.terminate();
        database = null;
    });

    afterAll(async () => {
        if (!globalThis.__DASHQL_TEST_HYPERDB_CLIENT__) await engineClient.terminate();
    });

    it('keeps a persistent database available across wrapper lifecycles', async () => {
        const databaseName = persistentDatabaseName('dashql_shell_persisted');
        let persistentDatabaseCreated = false;
        try {
            await database!.terminate();
            database = null;
            const first = await HyperDB.create(engineClient, undefined, {
                databasePrefix: `__dashql_persistence_${nextDatabase++}_`,
                terminateClient: false,
            });
            await first.createPersistentDatabase(databaseName);
            persistentDatabaseCreated = true;
            const writer = await first.connect();
            await writer.attachPersistentDatabase(databaseName, 'saved');
            await writer.query('CREATE TABLE saved.public.rows(id INTEGER)');
            await writer.query('INSERT INTO saved.public.rows VALUES (42)');
            await writer.close();
            await first.checkpointPersistentDatabase(databaseName);
            await first.terminate();

            const second = await HyperDB.create(engineClient, undefined, {
                databasePrefix: `__dashql_persistence_${nextDatabase++}_`,
                terminateClient: false,
            });
            const reader = await second.connect();
            await reader.attachPersistentDatabase(databaseName, 'saved');
            expect(toPlainObjects(await reader.query('SELECT id FROM saved.public.rows'))).toEqual([{ id: 42 }]);
            await reader.close();
            await second.dropPersistentDatabase(databaseName);
            persistentDatabaseCreated = false;
            await second.terminate();
        } finally {
            if (persistentDatabaseCreated) {
                await ignoreCleanupFailure(async () => {
                    const cleanup = await HyperDB.create(engineClient, undefined, {
                        databasePrefix: `__dashql_cleanup_${nextDatabase++}_`,
                        terminateClient: false,
                    });
                    try {
                        await cleanup.dropPersistentDatabase(databaseName);
                    } finally {
                        await cleanup.terminate();
                    }
                });
            }
        }
    }, 60_000);

    it('queries Hyper through Arrow IPC using the DashQL Arrow runtime', async () => {
        const connection = await database!.connect();
        const result = await connection.query("SELECT 42::INTEGER AS answer, 'hyper'::TEXT AS engine");

        expect(toPlainObjects(result)).toEqual([{ answer: 42, engine: 'hyper' }]);
        expect(await database!.getVersion()).toContain('hyper version');

        await connection.close();
    });

    it('queries a browser Blob through a registered WasmFS path', async () => {
        const connection = await database!.connect();
        const blob = new Blob(['value,name\n1,alpha\n2,beta\n'], { type: 'text/csv' });
        let path: string | null = null;
        try {
            path = await database!.registerExternalFile('values.csv', blob);
            expect(path).toMatch(/^\/mnt\/external\/[^/]+\/values\.csv$/);
            const result = await connection.query(`
                SELECT sum(value) AS total
                FROM external('${path}', format => 'csv', header => true,
                    columns => descriptor(value bigint, name text))
            `);
            expect(toPlainObjects(result)).toEqual([{ total: 3n }]);

            await database!.removeExternalFile(path);
            await expect(connection.query(`SELECT * FROM external('${path}', format => 'csv')`)).rejects.toThrow();
            path = null;
        } finally {
            if (path != null) await ignoreCleanupFailure(() => database!.removeExternalFile(path!));
            await connection.close();
        }
    }, 60_000);

    it('queries shell-mounted and streamed OPFS files', async () => {
        const connection = await database!.connect();
        const name = `values-${crypto.randomUUID()}.csv`;
        const file = new WebFile(new File(['value,name\n1,alpha\n2,beta\n'], name, { type: 'text/csv' }), name);
        const registry = new ShellFileRegistry(false, undefined, undefined, database!);
        let mounted: string | null = null;
        let imported: string | null = null;
        try {
            mounted = await registry.mountFile(file);
            expect(toPlainObjects(await connection.query(`
                SELECT sum(value) AS total
                FROM external('${mounted}', format => 'csv', header => true,
                    columns => descriptor(value bigint, name text))
            `))).toEqual([{ total: 3n }]);

            imported = await registry.importFile(file);
            expect(imported).toMatch(/^\/mnt\/opfs\/imported\//);
            expect(new TextDecoder().decode(await (await registry.get(imported))!.read()))
                .toBe('value,name\n1,alpha\n2,beta\n');
            expect(toPlainObjects(await connection.query(`
                SELECT sum(value) AS total
                FROM external('${imported}', format => 'csv', header => true,
                    columns => descriptor(value bigint, name text))
            `))).toEqual([{ total: 3n }]);
            const legacyPath = imported.replace(/^\/mnt\/opfs\//, '/opfs/');
            expect(toPlainObjects(await connection.query(`
                SELECT sum(value) AS total
                FROM external('${legacyPath}', format => 'csv', header => true,
                    columns => descriptor(value bigint, name text))
            `))).toEqual([{ total: 3n }]);
        } finally {
            if (mounted != null) await ignoreCleanupFailure(async () => { await registry.drop(mounted!); });
            if (imported != null) await ignoreCleanupFailure(async () => { await registry.drop(imported!); });
            await registry.dispose();
            await connection.close();
        }
    }, 60_000);

    it('initializes Hyper log introspection and rotation settings', async () => {
        const connection = await database!.connect();
        expect(await connection.query("SELECT * FROM hyper_log('current_session') LIMIT 0")).toBeDefined();
        await connection.close();
    });

    it('exposes function signatures through pg_proc introspection', async () => {
        const connection = await database!.connect({ defaultDatabase: 'hyper' });
        const result = await connection.query(`
            SELECT
                n.nspname AS function_schema,
                p.proname AS function_name,
                pg_catalog.pg_get_function_arguments(p.oid) AS function_arguments,
                pg_catalog.pg_get_function_result(p.oid) AS return_type,
                p.prokind AS function_kind
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.prokind IN ('f', 'a', 'w', 'p')
            ORDER BY n.nspname, p.proname
        `);

        expect(result.numRows).toBeGreaterThan(0);
        expect(toPlainObjects(result).find(row => row.function_name === 'abs')).toBeDefined();
        await connection.close();
    });

    it('returns no Arrow IPC chunks for successful DDL', async () => {
        const connection = await database!.connect();

        const result = await connection.queryArrowIPC('CREATE TABLE foo(a INT)');

        expect(result).toHaveLength(0);
        expect(toPlainObjects(await connection.query('SELECT * FROM foo'))).toEqual([]);
        await connection.close();
    });

    it('keeps compute and hyper as separate in-memory databases', async () => {
        const sourceDatabaseName = persistentDatabaseName('dashql_source');
        const localConnection = await database!.connect({ defaultDatabase: 'hyper' });
        const computeConnection = await database!.connect();
        let sourceCreated = false;
        let sourceAttached = false;
        try {
            await localConnection.query('CREATE TABLE local_state(user_id INT)');
            await computeConnection.query('CREATE TABLE compute_state(value INT)');

            await database!.createPersistentDatabase(sourceDatabaseName);
            sourceCreated = true;
            await localConnection.attachPersistentDatabase(sourceDatabaseName, 'source');
            sourceAttached = true;

            expect(toPlainObjects(await localConnection.query(
                'SELECT COUNT(*)::INTEGER AS row_count FROM hyper.public.local_state',
            ))).toEqual([{ row_count: 0 }]);
            expect(toPlainObjects(await computeConnection.query(
                'SELECT COUNT(*)::INTEGER AS row_count FROM compute_state',
            ))).toEqual([{ row_count: 0 }]);
            await expect(localConnection.query(
                'SELECT * FROM hyper.public.compute_state',
            )).rejects.toThrow();
            await expect(computeConnection.query(
                'SELECT * FROM local_state',
            )).rejects.toThrow();
        } finally {
            if (sourceAttached) await ignoreCleanupFailure(() => localConnection.detachPersistentDatabase('source'));
            if (sourceCreated) await ignoreCleanupFailure(() => database!.dropPersistentDatabase(sourceDatabaseName));
            await ignoreCleanupFailure(() => localConnection.close());
            await ignoreCleanupFailure(() => computeConnection.close());
        }
    });

    it('keeps shared tables visible across physical DataFrame connections', async () => {
        const inputName = generateTableName('__hyper_input');
        const summaryName = generateTableName('__hyper_summary');
        const input = await DataFrame.fromArrowTable(database!, arrow.tableFromArrays({
            id: new Int32Array([1, 2, 3]),
            label: ['alpha', 'beta', 'gamma'],
        }), inputName);

        const [firstRead, secondRead] = await Promise.all([
            input.readTable(),
            input.readTable(),
        ]);
        expect(toPlainObjects(firstRead)).toEqual([
            { id: 1, label: 'alpha' },
            { id: 2, label: 'beta' },
            { id: 3, label: 'gamma' },
        ]);
        expect(toPlainObjects(secondRead)).toEqual(toPlainObjects(firstRead));

        const summary = await DataFrame.fromSQL(
            database!,
            `SELECT COUNT(*)::INTEGER AS row_count FROM "${inputName}"`,
            summaryName,
        );
        expect(toPlainObjects(await summary.readTable())).toEqual([{ row_count: 3 }]);
        expect(client.createDatabaseCount).toBe(2);
        expect(client.connectCount).toBeGreaterThan(1);
        expect(client.attachDatabaseCount).toBe(client.connectCount);
        expect(client.disconnectCount).toBe(client.connectCount);
        expect(client.detachDatabaseCount).toBe(client.disconnectCount);

        await summary.destroy();
        await expect(summary.readTable()).rejects.toThrow();
        await input.destroy();
        await expect(input.readTable()).rejects.toThrow();
    });

    it('appends Arrow batches to a shared table', async () => {
        const first = await database!.connect();
        await first.insertArrowTable(arrow.tableFromArrays({ value: new Int32Array([1, 2]) }), {
            name: 'hyper_append_rows',
        });
        await first.close();

        const second = await database!.connect();
        await second.insertArrowTable(arrow.tableFromArrays({ value: new Int32Array([3, 4]) }), {
            name: 'hyper_append_rows',
            create: false,
        });
        await second.close();

        const reader = await database!.connect();
        expect(toPlainObjects(await reader.query('SELECT value FROM hyper_append_rows ORDER BY value'))).toEqual([
            { value: 1 },
            { value: 2 },
            { value: 3 },
            { value: 4 },
        ]);
        await reader.close();
    });
});
