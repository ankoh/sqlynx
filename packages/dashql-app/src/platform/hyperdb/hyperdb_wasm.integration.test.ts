import * as arrow from 'apache-arrow';
import type { MountSource } from 'hyperdb-wasm/raw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DataFrame, generateTableName } from '../../compute/data_frame.js';
import { WebFile } from '../file/web_file.js';
import { ShellFileRegistry } from '../../shell/shell_files.js';
import { createWebHyperDBClient, setupWebHyperDB } from './hyperdb_provider_web.js';
import { TestLogger } from '../logger/test_logger.js';
import { HyperDB, type HyperDBEngineClient, type HyperDBResult } from './hyperdb_wasm.js';

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

    mount(source: MountSource, path: string, mode: 'read' | 'readwrite'): Promise<HyperDBResult> {
        return this.client.mount(source, path, mode);
    }

    unmount(path: string): Promise<HyperDBResult> {
        return this.client.unmount(path);
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
            computeDatabasePath: `/mnt/fs/dashql-integration-${nextDatabase++}.hyper`,
            defaultDatabasePath: `/mnt/fs/dashql-integration-${nextDatabase++}.hyper`,
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

    it('persists an OPFS database file across wrapper lifecycles', async () => {
        const name = persistentDatabaseName('dashql_persisted');
        const path = `/mnt/fs/${name}.hyper`;
        const first = await database!.connect();
        let created = false;
        try {
            await first.query(`CREATE DATABASE ${quoteSqlIdentifier(path)}`);
            created = true;
            await first.query(`ATTACH DATABASE ${quoteSqlIdentifier(path)} AS saved`);
            await first.query('CREATE TABLE saved.public.rows(id INTEGER)');
            await first.query('INSERT INTO saved.public.rows VALUES (42)');
            await first.query('DETACH DATABASE saved');
            await first.close();
            await database!.terminate();
            database = null;

            database = await HyperDB.create(engineClient, undefined, {
                computeDatabasePath: `/mnt/fs/dashql-integration-${nextDatabase++}.hyper`,
                defaultDatabasePath: `/mnt/fs/dashql-integration-${nextDatabase++}.hyper`,
                terminateClient: false,
            });
            const second = await database.connect();
            try {
                await second.query(`ATTACH DATABASE ${quoteSqlIdentifier(path)} AS restored`);
                expect(toPlainObjects(await second.query('SELECT id FROM restored.public.rows'))).toEqual([{ id: 42 }]);
                await second.query('DETACH DATABASE restored');
            } finally {
                await second.close();
            }
        } finally {
            if (created && database != null) {
                const cleanup = await database.connect();
                try {
                    await ignoreCleanupFailure(async () => { await cleanup.query(`DROP DATABASE ${quoteSqlIdentifier(path)}`); });
                } finally {
                    await cleanup.close();
                }
            }
            await first.close();
        }
    }, 60_000);

    it('queries Hyper through Arrow IPC using the DashQL Arrow runtime', async () => {
        const connection = await database!.connect();
        const result = await connection.query("SELECT 42::INTEGER AS answer, 'hyper'::TEXT AS engine");

        expect(toPlainObjects(result)).toEqual([{ answer: 42, engine: 'hyper' }]);
        expect(await database!.getVersion()).toContain('hyper version');

        await connection.close();
    });

    it('creates and disposes a production OPFS session', async () => {
        const factory = globalThis.__DASHQL_TEST_HYPERDB_FACTORY__;
        globalThis.__DASHQL_TEST_HYPERDB_FACTORY__ = undefined;
        try {
            const sessionDatabase = await setupWebHyperDB('opfs_session_test', new TestLogger());
            const connection = await sessionDatabase.connect();
            expect(toPlainObjects(await connection.query('SELECT 42::INTEGER AS answer')))
                .toEqual([{ answer: 42 }]);
            await connection.close();
            await sessionDatabase.terminate();
        } finally {
            globalThis.__DASHQL_TEST_HYPERDB_FACTORY__ = factory;
        }
    }, 60_000);

    it('queries a browser Blob through a registered WasmFS path', async () => {
        const connection = await database!.connect();
        const blob = new Blob(['value,name\n1,alpha\n2,beta\n'], { type: 'text/csv' });
        let path: string | null = null;
        try {
            path = await database!.registerExternalFile('values with spaces \u00e9.csv', blob);
            expect(path).toBe('/mnt/external/values_with_spaces__.csv');
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

    it('queries a nested OPFS file through a registered browser directory', async () => {
        const connection = await database!.connect();
        const root = await navigator.storage.getDirectory();
        const name = `dashql-directory-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        const nested = await directory.getDirectoryHandle('input', { create: true });
        const file = await nested.getFileHandle('values.csv', { create: true });
        const writer = await file.createWritable();
        await writer.write('value,name\n1,alpha\n2,beta\n');
        await writer.close();
        let path: string | null = null;
        try {
            path = await database!.registerExternalDirectory(directory, `/mnt/external/${name}`, 'read');
            expect(toPlainObjects(await connection.query(`
                SELECT sum(value) AS total
                FROM external('${path}/input/values.csv', format => 'csv', header => true,
                    columns => descriptor(value bigint, name text))
            `))).toEqual([{ total: 3n }]);

            await database!.removeExternalDirectory(path);
            await expect(connection.query(`SELECT * FROM external('${path}/input/values.csv', format => 'csv')`)).rejects.toThrow();
            path = null;
        } finally {
            if (path != null) await ignoreCleanupFailure(() => database!.removeExternalDirectory(path!));
            await ignoreCleanupFailure(() => root.removeEntry(name, { recursive: true }));
            await connection.close();
        }
    }, 60_000);

    it('queries a shell-mounted file', async () => {
        const connection = await database!.connect();
        const name = `values-${crypto.randomUUID()}.csv`;
        const file = new WebFile(new File(['value,name\n1,alpha\n2,beta\n'], name, { type: 'text/csv' }), name);
        const registry = new ShellFileRegistry(undefined, database!);
        let mounted: string | null = null;
        try {
            mounted = await registry.mountFile(file);
            expect(toPlainObjects(await connection.query(`
                SELECT sum(value) AS total
                FROM external('${mounted}', format => 'csv', header => true,
                    columns => descriptor(value bigint, name text))
            `))).toEqual([{ total: 3n }]);
        } finally {
            if (mounted != null) await ignoreCleanupFailure(async () => { await registry.drop(mounted!); });
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
        expect(client.connectCount).toBeGreaterThan(1);
        expect(client.disconnectCount).toBe(client.connectCount);

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

function quoteSqlIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}
