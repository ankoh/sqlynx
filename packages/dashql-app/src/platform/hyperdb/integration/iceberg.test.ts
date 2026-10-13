import * as arrow from 'apache-arrow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWebHyperDBClient } from '../hyperdb_provider_web.js';
import { HyperDB, type HyperDBEngineClient } from '../hyperdb_wasm.js';

function toPlainObjects(table: arrow.Table): Record<string, unknown>[] {
    return table.toArray().map(row => Object.fromEntries(Object.keys(row).map(key => [key, row[key]])));
}

async function ignoreCleanupFailure(cleanup: () => Promise<void>): Promise<void> {
    try {
        await cleanup();
    } catch {
        // Preserve the test failure that triggered cleanup.
    }
}

describe('HyperDB Wasm Iceberg integration', () => {
    let engineClient: HyperDBEngineClient;
    let database: HyperDB | null = null;
    let nextDatabase = 1;

    beforeAll(async () => {
        engineClient = globalThis.__DASHQL_TEST_HYPERDB_CLIENT__
            ? await globalThis.__DASHQL_TEST_HYPERDB_CLIENT__()
            : await createWebHyperDBClient();
    });

    beforeEach(async () => {
        database = await HyperDB.create(engineClient, undefined, {
            computeDatabasePath: `/mnt/fs/dashql-iceberg-${nextDatabase++}.hyper`,
            defaultDatabasePath: `/mnt/fs/dashql-iceberg-${nextDatabase++}.hyper`,
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

    async function withReadWriteDirectory(test: (path: string) => Promise<void>): Promise<void> {
        const root = await navigator.storage.getDirectory();
        const name = `dashql-iceberg-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        let path: string | null = null;
        try {
            path = await database!.registerExternalDirectory(directory, 'readwrite');
            await test(path);
        } finally {
            if (path != null) await ignoreCleanupFailure(() => database!.removeExternalDirectory(path!));
            await ignoreCleanupFailure(() => root.removeEntry(name, { recursive: true }));
        }
    }

    it('inserts rows and preserves Iceberg metadata history', async () => {
        await withReadWriteDirectory(async path => {
            const connection = await database!.connect();
            try {
                await connection.query(`
                    COPY (SELECT a, a::text b FROM generate_series(1, 10) s(a) LIMIT 0)
                    TO '${path}/insert' WITH (format => 'iceberg')
                `);
                await connection.query(`CREATE EXTERNAL TABLE t FOR '${path}/insert' WITH (format => 'iceberg')`);
                expect(toPlainObjects(await connection.query('SELECT * FROM t'))).toEqual([]);

                await connection.query("INSERT INTO t VALUES (1, 'foo'), (2, 'bar')");
                expect(toPlainObjects(await connection.query(`
                    SELECT
                        json_array_length(metadata->'metadata-log')::integer AS history_length,
                        metadata->'metadata-log'->0->>'metadata-file' LIKE '%/metadata/00000-%.metadata.json' AS has_initial_metadata,
                        (metadata->'metadata-log'->0->>'timestamp-ms')::bigint < (metadata->>'last-updated-ms')::bigint AS timestamps_increase
                    FROM external('${path}/insert', format => 'iceberg', metaquery => 'metadata')
                `))).toEqual([{
                    history_length: 1,
                    has_initial_metadata: true,
                    timestamps_increase: true,
                }]);

                expect(toPlainObjects(await connection.query("INSERT INTO t VALUES (3, 'xoo'), (4, 'xar') RETURNING b, a"))).toEqual([
                    { b: 'xoo', a: 3 },
                    { b: 'xar', a: 4 },
                ]);
                expect(toPlainObjects(await connection.query(`
                    SELECT
                        json_array_length(metadata->'metadata-log')::integer AS history_length,
                        metadata->'metadata-log'->0->>'metadata-file' LIKE '%/metadata/00000-%.metadata.json' AS has_initial_metadata,
                        metadata->'metadata-log'->1->>'metadata-file' LIKE '%/metadata/00001-%.metadata.json' AS has_first_insert_metadata,
                        (metadata->'metadata-log'->0->>'timestamp-ms')::bigint < (metadata->'metadata-log'->1->>'timestamp-ms')::bigint AS history_timestamps_increase,
                        (metadata->'metadata-log'->1->>'timestamp-ms')::bigint < (metadata->>'last-updated-ms')::bigint AS timestamps_increase
                    FROM external('${path}/insert', format => 'iceberg', metaquery => 'metadata')
                `))).toEqual([{
                    history_length: 2,
                    has_initial_metadata: true,
                    has_first_insert_metadata: true,
                    history_timestamps_increase: true,
                    timestamps_increase: true,
                }]);
                expect(toPlainObjects(await connection.query('SELECT * FROM t ORDER BY a'))).toEqual([
                    { a: 1, b: 'foo' },
                    { a: 2, b: 'bar' },
                    { a: 3, b: 'xoo' },
                    { a: 4, b: 'xar' },
                ]);
            } finally {
                await connection.close();
            }
        });
    }, 60_000);

    it('inserts non-null values into nullable Iceberg columns', async () => {
        await withReadWriteDirectory(async path => {
            const connection = await database!.connect();
            try {
                await connection.query(`
                    COPY (SELECT NULL::integer a, NULL::text b, NULL::integer c LIMIT 0)
                    TO '${path}/insert_nullable' WITH (format => 'iceberg')
                `);
                await connection.query(`CREATE EXTERNAL TABLE tn FOR '${path}/insert_nullable' WITH (format => 'iceberg')`);
                await connection.query("INSERT INTO tn VALUES (1, 'foo', 10), (2, 'bar', 20)");

                expect(toPlainObjects(await connection.query('SELECT * FROM tn ORDER BY a'))).toEqual([
                    { a: 1, b: 'foo', c: 10 },
                    { a: 2, b: 'bar', c: 20 },
                ]);
            } finally {
                await connection.close();
            }
        });
    }, 60_000);

    it('writes inserted rows to Iceberg partition folders', async () => {
        await withReadWriteDirectory(async path => {
            const connection = await database!.connect();
            try {
                await connection.query(`
                    COPY (SELECT a, a::text b FROM generate_series(1, 10) s(a) LIMIT 0)
                    TO '${path}/insert_partitioned' WITH (format => 'iceberg') PARTITION BY a
                `);
                await connection.query(`CREATE EXTERNAL TABLE tp FOR '${path}/insert_partitioned' WITH (format => 'iceberg')`);
                await connection.query("INSERT INTO tp VALUES (10, 'foo'), (11, 'bar'), (11, 'baz')");
                expect(toPlainObjects(await connection.query("INSERT INTO tp VALUES (12, 'xoo'), (13, 'xar') RETURNING b, a"))).toEqual([
                    { b: 'xoo', a: 12 },
                    { b: 'xar', a: 13 },
                ]);

                expect(toPlainObjects(await connection.query(`
                    SELECT
                        right(left(right("metadata$filename", 200), length(right("metadata$filename", 200)) - strpos(reverse(right("metadata$filename", 200)), '/')), 4) AS partition,
                        a,
                        COUNT(*)::integer AS row_count
                    FROM tp
                    GROUP BY 1, 2
                    ORDER BY 2
                `))).toEqual([
                    { partition: 'a=10', a: 10, row_count: 1 },
                    { partition: 'a=11', a: 11, row_count: 2 },
                    { partition: 'a=12', a: 12, row_count: 1 },
                    { partition: 'a=13', a: 13, row_count: 1 },
                ]);
            } finally {
                await connection.close();
            }
        });
    }, 60_000);

    it('omits Parquet statistics when configured while retaining query results', async () => {
        await withReadWriteDirectory(async path => {
            const connection = await database!.connect();
            try {
                await connection.query(`
                    COPY (SELECT a, a::text b FROM generate_series(1, 10) s(a) LIMIT 0)
                    TO '${path}/insert_no_statistics' WITH (format => 'iceberg')
                `);
                await connection.query(`
                    CREATE EXTERNAL TABLE t_no_statistics FOR '${path}/insert_no_statistics'
                    WITH (format => 'iceberg', write_statistics => 'none')
                `);
                await connection.query("INSERT INTO t_no_statistics VALUES (1, 'foo'), (2, 'bar')");

                expect(toPlainObjects(await connection.query(`
                    SELECT DISTINCT c->'meta_data'->'statistics' IS NULL AS statistics_are_omitted
                    FROM external('${path}/insert_no_statistics', format => 'iceberg', "parquet.metaquery" => 'file'),
                         LATERAL json_array_elements(file_meta_data->'row_groups') rg(r),
                         LATERAL json_array_elements(r->'columns') cols(c)
                `))).toEqual([{ statistics_are_omitted: true }]);
                expect(toPlainObjects(await connection.query('SELECT * FROM t_no_statistics WHERE a > 1'))).toEqual([
                    { a: 2, b: 'bar' },
                ]);
            } finally {
                await connection.close();
            }
        });
    }, 60_000);
});
