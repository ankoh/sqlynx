import * as arrow from 'apache-arrow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWebHyperDBClient } from '../hyperdb_provider_web.js';
import { HYPERDB_WASM_ENGINE_SETTINGS } from '../hyperdb_settings.js';
import { HyperDB, quoteIdentifier, type HyperDBConnection, type HyperDBEngineClient } from '../hyperdb_wasm.js';
import {
    HyperDBIncrementalExtract,
    type HyperDBIncrementalExtractOptions,
    type HyperDBIncrementalExtractSource,
} from '../hyperdb_incremental_extract.js';
import {
    HYPER_LOG_EVENTS_TABLE,
    HYPER_LOG_MONITOR_SESSION_KEY,
    HYPER_LOG_QUERY_ENDS_TABLE,
    HyperDBLogSource,
} from '../hyperdb_log_extract.js';

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

function uniqueTag(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '_')}`;
}

/// Run queries against missing tables, every one ends with a query-end-user-error event naming its table.
async function failQueries(connection: HyperDBConnection, tag: string, count: number): Promise<void> {
    for (let i = 0; i < count; ++i) {
        await expect(connection.query(`SELECT * FROM ${tag}_missing_${i}`)).rejects.toThrow();
    }
}

/// Run successful queries, every one ends with a query-end event containing the tag.
async function succeedQueries(connection: HyperDBConnection, tag: string, count: number): Promise<void> {
    for (let i = 0; i < count; ++i) {
        await connection.query(`SELECT ${i} AS ${tag}`);
    }
}

async function readNumber(connection: HyperDBConnection, sql: string): Promise<number> {
    const result = await connection.query(sql);
    return Number(result.getChild(result.schema.fields[0].name)?.get(0) ?? 0);
}

/// Count the user errors since the last log scope reset of the connection.
async function countScopeUserErrors(connection: HyperDBConnection, currentSession = false): Promise<number> {
    return await readNumber(connection, `
        SELECT count(*) AS n
        FROM hyper_log(current_session := ${currentSession}, last_log_scope := true)
        WHERE k = 'query-end-user-error'
    `);
}

async function readSessionId(connection: HyperDBConnection): Promise<string> {
    const result = await connection.query("SELECT sess FROM hyper_log(current_session := true) WHERE sess <> '-' LIMIT 1");
    return result.getChild('sess')!.get(0) as string;
}

const READER_ALIAS = 'extract_reader';
const QUERY_ENDS = `${READER_ALIAS}.public.query_ends`;
const EVENTS = `${READER_ALIAS}.public.events`;

/// Count the extracted query ends of an outcome whose query text contains the tag.
async function countQueryEnds(connection: HyperDBConnection, outcome: string, tag: string): Promise<number> {
    return await readNumber(connection, `
        SELECT count(*) AS n FROM ${QUERY_ENDS} WHERE outcome = '${outcome}' AND query LIKE '%${tag}%'
    `);
}

/// Count the extracted user errors whose query text contains the tag.
function countUserErrors(connection: HyperDBConnection, tag: string): Promise<number> {
    return countQueryEnds(connection, 'query-end-user-error', tag);
}

async function createInitializedClient(): Promise<HyperDBEngineClient> {
    const client = await createWebHyperDBClient();
    await client.ready();
    const result = await client.initialize(JSON.stringify(HYPERDB_WASM_ENGINE_SETTINGS));
    if (result.state !== 'ok') throw new Error(`initialize HyperDB returned ${result.state}`);
    return client;
}

describe('HyperDB Wasm log extract', () => {
    /// The client of the source Hyper whose log is extracted
    let engineClient: HyperDBEngineClient;
    /// The client of a separate sink Hyper process that holds the extract file
    let sinkClient: HyperDBEngineClient;
    let database: HyperDB | null = null;
    let sinkDatabase: HyperDB | null = null;
    let nextDatabase = 1;
    let extractPath: string;
    let extract: HyperDBIncrementalExtract | null = null;
    let reader: HyperDBConnection | null = null;

    beforeAll(async () => {
        engineClient = globalThis.__DASHQL_TEST_HYPERDB_CLIENT__
            ? await globalThis.__DASHQL_TEST_HYPERDB_CLIENT__()
            : await createInitializedClient();
        sinkClient = await createInitializedClient();
    }, 60_000);

    beforeEach(async () => {
        database = await HyperDB.create(engineClient, undefined, {
            computeDatabasePath: `/mnt/fs/dashql-log-extract-${nextDatabase++}.hyper`,
            defaultDatabasePath: `/mnt/fs/dashql-log-extract-${nextDatabase++}.hyper`,
            terminateClient: false,
        });
        sinkDatabase = await HyperDB.create(sinkClient, undefined, {
            computeDatabasePath: `/mnt/fs/dashql-log-sink-${nextDatabase++}.hyper`,
            defaultDatabasePath: `/mnt/fs/dashql-log-sink-${nextDatabase++}.hyper`,
            terminateClient: false,
        });
        extractPath = `/mnt/fs/${uniqueTag('hyper_log_extract')}.hyper`;
    }, 60_000);

    afterEach(async () => {
        if (reader != null) {
            const connection = reader;
            reader = null;
            await ignoreCleanupFailure(async () => { await connection.execute(`DETACH DATABASE ${READER_ALIAS}`); });
            await connection.close();
        }
        if (extract != null) {
            const running = extract;
            extract = null;
            await running.stop();
        }
        const cleanup = await sinkDatabase!.connect();
        try {
            await ignoreCleanupFailure(async () => {
                await cleanup.execute(`DROP DATABASE IF EXISTS ${quoteIdentifier(extractPath)}`);
            });
        } finally {
            await cleanup.close();
        }
        await sinkDatabase?.terminate();
        sinkDatabase = null;
        await database?.terminate();
        database = null;
    });

    afterAll(async () => {
        await sinkClient?.terminate();
        if (!globalThis.__DASHQL_TEST_HYPERDB_CLIENT__) await engineClient.terminate();
    });

    /// Open an extract of the source log in the sink.
    async function openExtract(
        { sourceQuery, ...options }: Partial<HyperDBIncrementalExtractOptions> & { sourceQuery?: string } = {},
    ): Promise<HyperDBIncrementalExtract> {
        extract = await HyperDBIncrementalExtract.open({
            sourceDatabase: database!,
            source: new HyperDBLogSource(sourceQuery),
            sink: sinkDatabase!,
            databasePath: extractPath,
            tables: [HYPER_LOG_QUERY_ENDS_TABLE, HYPER_LOG_EVENTS_TABLE],
            ...options,
        });
        return extract;
    }

    /// A separate sink connection reading the extract file while the extractor writes it.
    async function openReader(): Promise<HyperDBConnection> {
        const connection = await sinkDatabase!.connect();
        await connection.execute(`ATTACH DATABASE ${quoteIdentifier(extractPath)} AS ${READER_ALIAS}`);
        reader = connection;
        return connection;
    }

    it('reads the log of the current session with named arguments', async () => {
        const connection = await database!.connect();
        try {
            await connection.query('SELECT 42 AS answer');
            const sample = await connection.query('SELECT * FROM hyper_log(current_session := true) LIMIT 1');
            expect(sample.schema.fields.map(field => field.name)).toEqual(expect.arrayContaining([
                'ts', 'pid', 'tid', 'sev', 'req', 'sess', 'ctx', 'k', 'v',
            ]));
            const elapsed = toPlainObjects(await connection.query(`
                SELECT (v->>'elapsed')::double precision AS elapsed
                FROM hyper_log(current_session := true)
                WHERE k = 'query-end'
            `));
            expect(elapsed.length).toBeGreaterThan(0);
            for (const row of elapsed) expect(row.elapsed).toBeGreaterThanOrEqual(0);
        } finally {
            await connection.close();
        }
    });

    it('advances the log scope per connection', async () => {
        const first = await database!.connect();
        const second = await database!.connect();
        const worker = await database!.connect();
        const tag = uniqueTag('scope');
        try {
            await first.execute('RESET hyper_log_scope_start');
            await second.execute('RESET hyper_log_scope_start');
            await failQueries(worker, `${tag}_a`, 2);
            await second.execute('RESET hyper_log_scope_start');
            await failQueries(worker, `${tag}_b`, 1);

            expect(await countScopeUserErrors(first)).toBe(3);
            expect(await countScopeUserErrors(second)).toBe(1);
            // The scope of the monitor's own session contains none of the worker's errors.
            expect(await countScopeUserErrors(first, true)).toBe(0);

            await first.execute('RESET hyper_log_scope_start');
            expect(await countScopeUserErrors(first)).toBe(0);
        } finally {
            await worker.close();
            await second.close();
            await first.close();
        }
    });

    it('starts the log scope of a new connection at its creation', async () => {
        const worker = await database!.connect();
        const tag = uniqueTag('fresh');
        let monitor: HyperDBConnection | null = null;
        try {
            await failQueries(worker, `${tag}_before`, 1);
            monitor = await database!.connect();
            expect(await countScopeUserErrors(monitor)).toBe(0);
            await failQueries(worker, `${tag}_after`, 1);
            expect(await countScopeUserErrors(monitor)).toBe(1);
        } finally {
            await monitor?.close();
            await worker.close();
        }
    });

    it('appends every log event exactly once', async () => {
        const worker = await database!.connect();
        const tag = uniqueTag('grow');
        try {
            await openExtract();
            const connection = await openReader();

            await failQueries(worker, `${tag}_a`, 2);
            await succeedQueries(worker, `${tag}_ok`, 2);
            expect((await extract!.poll()).appended).toBeGreaterThan(0);
            expect(await countUserErrors(connection, tag)).toBe(2);

            await failQueries(worker, `${tag}_b`, 1);
            await extract!.poll();
            expect(await countUserErrors(connection, tag)).toBe(3);
            expect(await countUserErrors(connection, `${tag}_a_missing_0`)).toBe(1);
            expect(await countQueryEnds(connection, 'query-end', `${tag}_ok`)).toBe(2);

            // Without new failures, a poll appends no further errors.
            await extract!.poll();
            expect(await countUserErrors(connection, tag)).toBe(3);
        } finally {
            await worker.close();
        }
    }, 60_000);

    it('writes typed rows into the configured tables', async () => {
        const worker = await database!.connect();
        const tag = uniqueTag('typed');
        try {
            await openExtract({
                tables: [HYPER_LOG_QUERY_ENDS_TABLE, {
                    name: 'user_errors',
                    query: `
                        SELECT ts, v::json->>'error-code' AS code, v::json->>'error-message' AS message
                        FROM log WHERE k = 'query-end-user-error'
                    `,
                }],
            });
            expect(extract!.schemas.user_errors).toEqual([
                { name: 'ts', type: 'timestamp' },
                { name: 'code', type: 'text' },
                { name: 'message', type: 'text' },
            ]);
            expect(extract!.schemas.query_ends).toContainEqual({ name: 'elapsed', type: 'double precision' });
            expect(extract!.schemas.query_ends).toContainEqual({ name: 'rows', type: 'bigint' });
            await succeedQueries(worker, tag, 1);
            await failQueries(worker, tag, 2);
            const transfer = await extract!.poll();
            expect(Object.keys(transfer.tables)).toEqual(['query_ends', 'user_errors']);
            expect(transfer.tables.user_errors).toBe(2);
            expect(transfer.tables.query_ends).toBeGreaterThanOrEqual(3);

            const connection = await openReader();
            expect(toPlainObjects(await connection.query(`
                SELECT code, message FROM ${READER_ALIAS}.public.user_errors WHERE message LIKE '%${tag}%' ORDER BY message
            `))).toEqual([
                { code: '42P01', message: `table "${tag}_missing_0" does not exist` },
                { code: '42P01', message: `table "${tag}_missing_1" does not exist` },
            ]);
            const [success] = toPlainObjects(await connection.query(`
                SELECT statement, elapsed, rows, error_code FROM ${QUERY_ENDS} WHERE outcome = 'query-end' AND query LIKE '%${tag}%'
            `));
            expect(success.statement).toBe('SELECT');
            expect(typeof success.elapsed).toBe('number');
            expect(success.rows).toBe(1n);
            expect(success.error_code).toBeNull();
        } finally {
            await worker.close();
        }
    }, 60_000);

    it('selects the events with a source query', async () => {
        const kept = await database!.connect();
        const ignored = await database!.connect();
        const tag = uniqueTag('filter');
        try {
            const ignoredSession = await readSessionId(ignored);
            await openExtract({
                sourceQuery: `SELECT * FROM log WHERE sess IS DISTINCT FROM '${ignoredSession}' AND k LIKE 'query-%'`,
            });
            await failQueries(kept, `${tag}_kept`, 1);
            await failQueries(ignored, `${tag}_ignored`, 1);
            await extract!.poll();

            const connection = await openReader();
            expect(await countUserErrors(connection, `${tag}_kept`)).toBe(1);
            expect(await countUserErrors(connection, `${tag}_ignored`)).toBe(0);
            expect(await readNumber(connection, `SELECT count(*) AS n FROM ${EVENTS} WHERE k NOT LIKE 'query-%'`)).toBe(0);
            expect(await readNumber(connection, `SELECT count(*) AS n FROM ${EVENTS} WHERE sess = '${ignoredSession}'`)).toBe(0);
        } finally {
            await ignored.close();
            await kept.close();
        }
    }, 60_000);

    it('rejects invalid queries before reading events', async () => {
        await expect(openExtract({ sourceQuery: 'SELECT ts, k FROM log' }))
            .rejects.toThrow(/source query must return the source columns: missing pid/);
        await expect(openExtract({ sourceQuery: 'SELECT *, 1 AS extra FROM log' }))
            .rejects.toThrow(/unexpected extra/);
        await expect(openExtract({ sourceQuery: 'SELECT * FROM nope' }))
            .rejects.toThrow(/invalid source query/);
        await expect(openExtract({ tables: [{ name: 'broken', query: 'SELECT nope FROM log' }] }))
            .rejects.toThrow(/invalid query of the extract table broken/);
        await expect(openExtract({ tables: [{ name: 'twice', query: 'SELECT ts, ts FROM log' }] }))
            .rejects.toThrow(/returns the column ts twice/);
        await expect(openExtract({ tables: [{ name: 'internal', query: 'SELECT 1 AS __row FROM log' }] }))
            .rejects.toThrow(/column name __row of the extract table internal is reserved/);
        await expect(openExtract({ tables: [{ name: 'limited', query: 'SELECT ts FROM log', maxRows: 0 }] }))
            .rejects.toThrow(/row limit of the extract table limited must be a positive integer/);
        extract = null;
    }, 60_000);

    it('rejects a table query that no longer matches its table', async () => {
        await openExtract({ tables: [{ name: 'changing', query: 'SELECT ts, k FROM log' }] });
        await extract!.stop();
        extract = null;
        await expect(openExtract({ tables: [{ name: 'changing', query: 'SELECT ts, k, v FROM log' }] }))
            .rejects.toThrow(/the extract table changing has the columns \(ts timestamp, k text\)/);
        extract = null;
    }, 60_000);

    it('computes operational metrics over the extract', async () => {
        const worker = await database!.connect();
        const tag = uniqueTag('metrics');
        try {
            await openExtract();
            await succeedQueries(worker, tag, 3);
            await failQueries(worker, tag, 2);
            await extract!.poll();

            const connection = await openReader();
            const [metrics] = toPlainObjects(await connection.query(`
                SELECT
                    count(*) FILTER (WHERE outcome = 'query-end')              AS succeeded,
                    count(*) FILTER (WHERE outcome = 'query-end-user-error')   AS user_errors,
                    count(*) FILTER (WHERE outcome = 'query-end-system-error') AS system_errors,
                    count(*) FILTER (WHERE outcome = 'query-end-canceled')     AS canceled,
                    avg(elapsed) FILTER (WHERE outcome = 'query-end')          AS avg_elapsed_seconds,
                    max(elapsed)                                               AS max_elapsed_seconds
                FROM ${QUERY_ENDS}
                WHERE query LIKE '%${tag}%'
            `));
            expect(Number(metrics.succeeded)).toBe(3);
            expect(Number(metrics.user_errors)).toBe(2);
            expect(Number(metrics.system_errors)).toBe(0);
            expect(Number(metrics.canceled)).toBe(0);
            expect(metrics.avg_elapsed_seconds).toBeGreaterThan(0);
            expect(metrics.max_elapsed_seconds).toBeGreaterThanOrEqual(metrics.avg_elapsed_seconds as number);
        } finally {
            await worker.close();
        }
    }, 60_000);

    it('recovers the events since the last poll after a reconnect', async () => {
        const worker = await database!.connect();
        const tag = uniqueTag('reconnect');
        try {
            await openExtract();
            await failQueries(worker, `${tag}_polled`, 1);
            await extract!.poll();
            // Written after the last poll of the first connection.
            await failQueries(worker, `${tag}_unpolled`, 1);
            await extract!.stop();
            extract = null;
            // Written while no monitor connection exists.
            await failQueries(worker, `${tag}_disconnected`, 2);

            await openExtract();
            const connection = await openReader();
            const count = (suffix: string) => countUserErrors(connection, `${tag}_${suffix}`);
            expect(await count('polled')).toBe(1);
            expect(await count('unpolled')).toBe(1);
            expect(await count('disconnected')).toBe(2);

            // The first poll reads events of the backfill again and skips them.
            await failQueries(worker, `${tag}_reconnected`, 1);
            await extract!.poll();
            expect(await count('polled')).toBe(1);
            expect(await count('unpolled')).toBe(1);
            expect(await count('disconnected')).toBe(2);
            expect(await count('reconnected')).toBe(1);
        } finally {
            await worker.close();
        }
    }, 60_000);

    it('backfills a reconnect from the timestamp watermark', async () => {
        const worker = await database!.connect();
        const tag = uniqueTag('watermark');
        try {
            const first = await openExtract();
            // An empty extract has no watermark and backfills all retained events.
            expect(first.backfill.appended).toBeGreaterThan(0);
            await succeedQueries(worker, tag, 20);
            await first.poll();
            await first.stop();
            extract = null;
            await failQueries(worker, `${tag}_gap`, 1);

            const retained = await readNumber(worker, `
                SELECT count(*) AS n FROM hyper_log(current_session := false, last_log_scope := false)
            `);
            const second = await openExtract({ backfillOverlapMs: 0 });
            expect(second.backfill.fetched).toBeGreaterThan(0);
            expect(second.backfill.fetched).toBeLessThan(retained);
            expect(second.backfill.appended).toBeGreaterThan(0);

            const connection = await openReader();
            expect(await countUserErrors(connection, `${tag}_gap`)).toBe(1);
            expect(await countQueryEnds(connection, 'query-end', tag)).toBe(20);
        } finally {
            await worker.close();
        }
    }, 60_000);

    it('stores every event once across repeated reconnects', async () => {
        const worker = await database!.connect();
        const tag = uniqueTag('repeat');
        try {
            for (let i = 0; i < 3; ++i) {
                await openExtract();
                await succeedQueries(worker, `${tag}_${i}`, 2);
                await failQueries(worker, `${tag}_${i}`, 1);
                await extract!.poll();
                await failQueries(worker, `${tag}_${i}_tail`, 1);
                await extract!.stop();
                extract = null;
            }
            await openExtract();

            const connection = await openReader();
            expect(await countUserErrors(connection, tag)).toBe(6);
            expect(await countQueryEnds(connection, 'query-end', tag)).toBe(6);
            for (const table of [EVENTS, QUERY_ENDS]) {
                expect(await readNumber(connection, `
                    SELECT count(*) AS n FROM (SELECT * FROM ${table} GROUP BY ALL HAVING count(*) > 1) duplicates
                `)).toBe(0);
            }
            // The monitor sessions of all four connections are recorded, and none of their events are extracted.
            const monitors = `
                SELECT value FROM ${READER_ALIAS}.public.__state WHERE key = '${HYPER_LOG_MONITOR_SESSION_KEY}'
            `;
            expect(await readNumber(connection, `SELECT count(*) AS n FROM (${monitors}) m`)).toBe(4);
            expect(await readNumber(connection, `
                SELECT count(*) AS n FROM ${EVENTS} WHERE sess IN (${monitors})
            `)).toBe(0);
        } finally {
            await worker.close();
        }
    }, 60_000);

    it('polls periodically until stopped', async () => {
        const worker = await database!.connect();
        const tag = uniqueTag('timer');
        const errors: unknown[] = [];
        try {
            await openExtract({
                intervalMs: 50,
                onError: error => errors.push(error),
            });
            const connection = await openReader();
            extract!.start();
            await failQueries(worker, tag, 1);

            const deadline = performance.now() + 10_000;
            while (await countUserErrors(connection, tag) === 0) {
                if (performance.now() > deadline) throw new Error('the extract did not pick up the error in time');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            await extract!.stop();
            extract = null;
            expect(errors).toEqual([]);

            const rows = await readNumber(connection, `SELECT count(*) AS n FROM ${EVENTS}`);
            await failQueries(worker, `${tag}_late`, 1);
            await new Promise(resolve => setTimeout(resolve, 200));
            expect(await readNumber(connection, `SELECT count(*) AS n FROM ${EVENTS}`)).toBe(rows);
        } finally {
            await worker.close();
        }
    }, 60_000);

    it('extracts an append-only table by its watermark', async () => {
        const writer = await database!.connect();
        const sourceTable = uniqueTag('append_only');
        try {
            await writer.execute(`CREATE TABLE ${sourceTable} (ts TIMESTAMP, id INTEGER, payload TEXT)`);
            await writer.execute(`INSERT INTO ${sourceTable} VALUES
                ('2026-10-23 10:00:00', 1, 'a'), ('2026-10-23 10:00:01', 2, 'b'), ('2026-10-23 10:00:02', 3, 'c')`);
            // Without an update query, every poll is a backfill from the watermark.
            const source: HyperDBIncrementalExtractSource = {
                relation: 'changes',
                columns: [
                    { name: 'ts', type: 'TIMESTAMP' },
                    { name: 'id', type: 'INTEGER' },
                    { name: 'payload', type: 'TEXT' },
                ],
                watermarkColumn: 'ts',
                backfillQuery: since => `SELECT ts, id, payload FROM ${sourceTable}${since == null ? '' : ` WHERE ${since}`}`,
            };
            extract = await HyperDBIncrementalExtract.open({
                sourceDatabase: database!,
                source,
                sink: sinkDatabase!,
                databasePath: extractPath,
                tables: [
                    { name: 'copy', query: 'SELECT id, upper(payload) AS payload FROM changes' },
                    { name: 'latest', query: 'SELECT ts, id FROM changes', maxRows: 2 },
                ],
                backfillOverlapMs: 1_000,
            });
            expect(extract.backfill).toEqual({
                fetched: 3, appended: 3, tables: { copy: 3, latest: 3 }, deleted: { latest: 1 },
            });
            expect(extract.schemas.copy).toEqual([{ name: 'id', type: 'integer' }, { name: 'payload', type: 'text' }]);

            // A row with the watermark ts, a newer row, and a late row before the overlap.
            await writer.execute(`INSERT INTO ${sourceTable} VALUES
                ('2026-10-23 10:00:02', 4, 'd'), ('2026-10-23 10:00:03', 5, 'e'), ('2026-10-23 09:00:00', 6, 'late')`);
            // The poll reads the rows from 10:00:01 again and skips 2 and 3.
            expect(await extract.poll()).toEqual({
                fetched: 4, appended: 2, tables: { copy: 2, latest: 2 }, deleted: { latest: 2 },
            });
            // The rows from 10:00:02 are read again, two of them share the ts.
            expect(await extract.poll()).toEqual({
                fetched: 3, appended: 0, tables: { copy: 0, latest: 0 }, deleted: { latest: 0 },
            });

            const connection = await openReader();
            expect(toPlainObjects(await connection.query(`SELECT id, payload FROM ${READER_ALIAS}.public.copy ORDER BY id`)))
                .toEqual([
                    { id: 1, payload: 'A' },
                    { id: 2, payload: 'B' },
                    { id: 3, payload: 'C' },
                    { id: 4, payload: 'D' },
                    { id: 5, payload: 'E' },
                ]);
            // The row limit keeps the newest rows, numbered by the watermark within a transfer.
            expect(toPlainObjects(await connection.query(`
                SELECT "__row" AS row, id FROM ${READER_ALIAS}.public.latest ORDER BY "__row"
            `))).toEqual([{ row: 4n, id: 4 }, { row: 5n, id: 5 }]);
        } finally {
            await ignoreCleanupFailure(async () => { await writer.execute(`DROP TABLE ${sourceTable}`); });
            await writer.close();
        }
    }, 60_000);
});
