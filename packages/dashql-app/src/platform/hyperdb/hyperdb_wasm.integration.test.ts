import * as arrow from 'apache-arrow';
import type { MountSource } from 'hyperdb-wasm/raw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DataFrame, generateTableName } from '../../compute/data_frame.js';
import { WebFile } from '../file/web_file.js';
import { ShellFileRegistry } from '../../shell/shell_files.js';
import { createWebHyperDBClient, setupWebHyperDB } from './hyperdb_provider_web.js';
import { HYPER_INSTANCE_LOGS_DIRECTORY, HYPER_INSTANCES_DIRECTORY } from './hyperdb_opfs_instance.js';
import { TestLogger } from '../logger/test_logger.js';
import { HyperDB, type HyperDBEngineClient, type HyperDBResult } from './hyperdb_wasm.js';
import { exportArrowTableAsParquet, PARQUET_EXPORT_DIRECTORY } from './hyperdb_parquet_export.js';

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
            await first.execute(`CREATE DATABASE ${quoteSqlIdentifier(path)}`);
            created = true;
            await first.execute(`ATTACH DATABASE ${quoteSqlIdentifier(path)} AS saved`);
            await first.execute('CREATE TABLE saved.public.rows(id INTEGER)');
            await first.execute('INSERT INTO saved.public.rows VALUES (42)');
            await first.execute('DETACH DATABASE saved');
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
                await second.execute(`ATTACH DATABASE ${quoteSqlIdentifier(path)} AS restored`);
                expect(toPlainObjects(await second.query('SELECT id FROM restored.public.rows'))).toEqual([{ id: 42 }]);
                await second.execute('DETACH DATABASE restored');
            } finally {
                await second.close();
            }
        } finally {
            if (created && database != null) {
                const cleanup = await database.connect();
                try {
                    await ignoreCleanupFailure(async () => { await cleanup.execute(`DROP DATABASE ${quoteSqlIdentifier(path)}`); });
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

    it('creates and disposes a production OPFS instance', async () => {
        const factory = globalThis.__DASHQL_TEST_HYPERDB_FACTORY__;
        globalThis.__DASHQL_TEST_HYPERDB_FACTORY__ = undefined;
        const listInstances = async () => {
            const instances = await (await navigator.storage.getDirectory())
                .getDirectoryHandle(HYPER_INSTANCES_DIRECTORY, { create: true });
            const names: string[] = [];
            for await (const name of instances.keys()) names.push(name);
            return names;
        };
        try {
            const before = new Set(await listInstances());
            const instanceDatabase = await setupWebHyperDB('opfs_instance_test', new TestLogger());
            const created = (await listInstances()).filter(name => !before.has(name));
            expect(created).toHaveLength(1);
            const connection = await instanceDatabase.connect();
            expect(toPlainObjects(await connection.query('SELECT 42::INTEGER AS answer')))
                .toEqual([{ answer: 42 }]);
            // The instance writes its Hyper log into its own folder, and hyper_log() reads it from there.
            const logs = await (await (await (await navigator.storage.getDirectory())
                .getDirectoryHandle(HYPER_INSTANCES_DIRECTORY)).getDirectoryHandle(created[0]))
                .getDirectoryHandle(HYPER_INSTANCE_LOGS_DIRECTORY);
            const logFiles: string[] = [];
            for await (const name of logs.keys()) logFiles.push(name);
            expect(logFiles.some(name => /^hyperd_.*\.log$/.test(name))).toBe(true);
            expect(toPlainObjects(await connection.query(`
                SELECT count(*)::INTEGER AS n FROM hyper_log(current_session := true) WHERE k = 'query-end'
            `))[0].n).toBeGreaterThan(0);
            await connection.close();
            await instanceDatabase.terminate();
            expect(await listInstances()).not.toContain(created[0]);
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

    it('queries session CSV data directly from the canonical OPFS path without registration', async () => {
        const connection = await database!.connect();
        const root = await navigator.storage.getDirectory();
        const sessions = await root.getDirectoryHandle('sessions', { create: true });
        const sessionId = crypto.randomUUID();
        try {
            const session = await sessions.getDirectoryHandle(sessionId, { create: true });
            const attachments = await session.getDirectoryHandle('attachments', { create: true });
            const file = await attachments.getFileHandle('values.csv', { create: true });
            const writer = await file.createWritable();
            await writer.write('value,name\n1,alpha\n2,beta\n');
            await writer.close();

            expect(toPlainObjects(await connection.query(`
                SELECT value, name
                FROM external('/mnt/fs/sessions/${sessionId}/attachments/values.csv', format => 'csv', header => true,
                    columns => descriptor(value bigint, name text))
                ORDER BY value
            `))).toEqual([{ value: 1n, name: 'alpha' }, { value: 2n, name: 'beta' }]);
        } finally {
            await connection.close();
            await ignoreCleanupFailure(() => sessions.removeEntry(sessionId, { recursive: true }));
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

    it('exports an Arrow table as Parquet through OPFS', async () => {
        const table = arrow.tableFromArrays({
            id: Int32Array.from([1, 2, 3]),
            name: ['alpha', 'beta', 'gamma'],
        });
        const bytes = await exportArrowTableAsParquet(database!, table);
        expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('PAR1');
        expect(new TextDecoder().decode(bytes.subarray(bytes.byteLength - 4))).toBe('PAR1');

        const root = await navigator.storage.getDirectory();
        const exports = await root.getDirectoryHandle(PARQUET_EXPORT_DIRECTORY);
        const remaining: string[] = [];
        for await (const name of exports.keys()) remaining.push(name);
        expect(remaining).toEqual([]);

        const connection = await database!.connect();
        let path: string | null = null;
        try {
            path = await database!.registerExternalFile('export.parquet', new Blob([bytes as BlobPart]));
            expect(toPlainObjects(await connection.query(`SELECT id, name FROM external('${path}') ORDER BY id`)))
                .toEqual([{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }, { id: 3, name: 'gamma' }]);
        } finally {
            if (path != null) await ignoreCleanupFailure(() => database!.removeExternalFile(path!));
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

    it('returns the affected rows of executed statements', async () => {
        const connection = await database!.connect();

        expect(await connection.execute('CREATE TABLE executed(a INT)')).toBeNull();
        expect(await connection.execute('INSERT INTO executed VALUES (1), (2), (3)')).toBe(3n);
        expect(await connection.execute('UPDATE executed SET a = a + 1 WHERE a > 1')).toBe(2n);
        expect(await connection.execute('DELETE FROM executed WHERE a = 1')).toBe(1n);
        expect(await connection.execute('DROP TABLE executed')).toBeNull();
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
        const connectsAfterReads = client.connectCount;

        const summary = await DataFrame.fromSQL(
            database!,
            `SELECT COUNT(*)::INTEGER AS row_count FROM "${inputName}"`,
            summaryName,
        );
        expect(toPlainObjects(await summary.readTable())).toEqual([{ row_count: 3 }]);
        // Later statements reuse the attached sessions of the parallel reads.
        expect(client.connectCount).toBe(connectsAfterReads);

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
