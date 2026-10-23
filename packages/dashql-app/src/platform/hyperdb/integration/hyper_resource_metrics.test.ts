import * as arrow from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { createTestHyperDBClient } from '../../../tests/hyperdb_test_client.js';
import { HyperDB, HyperDBEngine, quoteIdentifier, type HyperDBConnection } from '../hyperdb_wasm.js';
import { HyperDBIncrementalExtract } from '../hyperdb_incremental_extract.js';
import { HYPER_LOG_RESOURCE_METRICS_TABLE, HyperDBLogSource } from '../hyperdb_log_extract.js';

function toPlainObjects(table: arrow.Table): Record<string, unknown>[] {
    return table.toArray().map(row => Object.fromEntries(Object.keys(row).map(key => [key, row[key]])));
}

/// The startup settings that write resource metrics to the log every second, also without load.
const RESOURCE_METRICS_SETTINGS = {
    log_resource_usage_interval: '1s',
    log_resource_usage_always: 1,
};
/// All recorders of log_resource_usage_mode, from system memory (1) to cgroup memory (2048).
const ALL_RESOURCE_RECORDERS = 4095;

/// The objects of resource-metrics events whose keys are names, e.g. of memory trackers, and not fields.
const RESOURCE_METRICS_MAPS = new Set([
    'mem-trackers.memory_tracked_current_usage_mb',
    'mem-trackers.memory_tracked_peak_usage_mb',
]);

/// The JSON schema of the resource-metrics events with the default recorders.
/// Paths use `*` for map keys and labels, `[]` for array elements. `{}` is a gauge that Wasm does not record.
const DEFAULT_RESOURCE_METRICS_SCHEMA = {
    'cache-filesystem.cache_filesystem_available_mb': '{}',
    'cache-filesystem.cache_filesystem_cached_mb': '{}',
    'cache-filesystem.cache_filesystem_cached_peak_mb': '{}',
    'cache-filesystem.cache_filesystem_effectively_available_mb': '{}',
    'cache-filesystem.cache_filesystem_size_mb': '{}',
    'has-load': 'boolean',
    'load.cpu_load': '{}',
    'load.memory_buckets_load': 'number',
    'load.memory_load': 'number',
    'load.overall_load': 'number',
    'load.scheduler_load': 'number',
    'load.total_instance_time.*.*.*': 'number',
    'load.total_instance_time_available.*': 'number',
    'load.total_memory_time_mb_seconds.*.*.*': 'number',
    'load.total_network_io_usage_mb.*.*.*': 'number',
    'load.total_thread_time.*.*.*': 'number',
    'load.workspace_load': 'number',
    'mem-trackers.memory_tracked_current_usage_mb.*': 'number',
    'mem-trackers.memory_tracked_peak_usage_mb.*': 'number',
    'memory.process_file_mappings_mb': '{}',
    'memory.process_physical_memory_mb': 'number',
    'memory.process_virtual_memory_mb': '{}',
    'memory.system_physical_memory_mb': 'number',
    'memory.system_virtual_memory_mb': '{}',
    'memory.total_physical_memory_mb': 'number',
    'memory.total_virtual_memory_mb': '{}',
    'multiplexer.multiplexer_active_scopes': '{}',
    'multiplexer.multiplexer_cpu_time.count': 'number',
    'multiplexer.multiplexer_cpu_time.max': 'number',
    'multiplexer.multiplexer_cpu_time.min': 'number',
    'multiplexer.multiplexer_cpu_time.total': 'number',
    'multiplexer.multiplexer_executed_continuations.max': 'number',
    'multiplexer.multiplexer_executed_continuations.min': 'number',
    'multiplexer.multiplexer_executed_continuations.total': 'number',
    'scheduler-thread-count.scheduler_fully_suspended_jobs_count': 'number',
    'scheduler-thread-count.scheduler_thread_count.active': 'number',
    'scheduler-thread-count.scheduler_thread_count.inactive': 'number',
    'scheduler-thread-count.scheduler_waiting_jobs_count': 'number',
    'volume-cache-trackers.volume_current_mb': '{}',
    'volume-cache-trackers.volume_peak_mb': '{}',
};

/// The paths that all recorders add to the default ones.
const ALL_RECORDERS_RESOURCE_METRICS_SCHEMA = {
    ...DEFAULT_RESOURCE_METRICS_SCHEMA,
    'cpu.process_cpu_utilization': '{}',
    'cpu.system_cpu_utilization': '{}',
    'filesystem.filesystem_available_mb': '{}',
    'filesystem.filesystem_size_mb': '{}',
    'multiplexer-threads[].id': 'number',
    'multiplexer-threads[].s': 'string',
    'multiplexer-threads[].t': 'string',
    'scheduler-threads[].id': 'number',
    'scheduler-threads[].s': 'string',
    'scheduler-threads[].t': 'string',
};

/// The JSON types of all leaf paths of a value.
function collectJsonTypes(value: unknown, path: string, types: Map<string, Set<string>>): void {
    const add = (type: string) => types.set(path, (types.get(path) ?? new Set()).add(type));
    if (Array.isArray(value)) {
        if (value.length === 0) add('[]');
        for (const element of value) collectJsonTypes(element, `${path}[]`, types);
    } else if (value !== null && typeof value === 'object') {
        const fields = Object.entries(value);
        if (fields.length === 0) add('{}');
        for (const [key, field] of fields) {
            const name = RESOURCE_METRICS_MAPS.has(path) || /^[0-9.]+$/.test(key) ? '*' : key;
            collectJsonTypes(field, path === '' ? name : `${path}.${name}`, types);
        }
    } else {
        add(value === null ? 'null' : typeof value);
    }
}

/// The JSON schema of a list of values, the union of the types of every path.
function inferJsonSchema(values: readonly unknown[]): Record<string, string> {
    const types = new Map<string, Set<string>>();
    for (const value of values) collectJsonTypes(value, '', types);
    return Object.fromEntries([...types.keys()].sort().map(path => [path, [...types.get(path)!].sort().join('|')]));
}

/// Run a query that keeps all scheduler threads busy and holds hash table memory for a while.
async function runWorkload(connection: HyperDBConnection): Promise<void> {
    await connection.query(`
        SELECT g, count(*) FROM (SELECT x % 1000000 AS g FROM generate_series(1, 10000000) s(x)) t
        GROUP BY g ORDER BY 2 DESC LIMIT 1
    `);
}

async function readNumber(connection: HyperDBConnection, sql: string): Promise<number> {
    const result = await connection.query(sql);
    return Number(result.getChild(result.schema.fields[0].name)?.get(0) ?? 0);
}

/// Wait until the log holds a number of resource-metrics events, failing with the logged keys otherwise.
async function waitForResourceMetrics(connection: HyperDBConnection, count: number): Promise<void> {
    const deadline = performance.now() + 10_000;
    while (await readNumber(connection, `
        SELECT count(*) AS n FROM hyper_log(current_session := false) WHERE k = 'resource-metrics'
    `) < count) {
        if (performance.now() > deadline) {
            const keys = await connection.query(`
                SELECT k, count(*) AS n FROM hyper_log(current_session := false) GROUP BY k ORDER BY k
            `);
            throw new Error(`the log has no ${count} resource-metrics events after 10s, it has: ${
                toPlainObjects(keys).map(({ k, n }) => `${k as string} (${n as bigint})`).join(', ')
            }`);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

/// The resource events of the log in log order, with the timestamps in milliseconds.
async function readResourceEvents(connection: HyperDBConnection): Promise<{ ts: number; sess: string; k: string; v: unknown }[]> {
    const result = await connection.query(`
        SELECT (extract(epoch FROM ts::timestamp) * 1000)::double precision AS ts, sess, k, v::text AS v
        FROM hyper_log(current_session := false)
        WHERE k LIKE 'resource-metrics%'
        ORDER BY 1
    `);
    return toPlainObjects(result).map(row => ({
        ts: row.ts as number,
        sess: row.sess as string,
        k: row.k as string,
        v: JSON.parse(row.v as string),
    }));
}

describe('HyperDB Wasm resource metrics', () => {
    let nextDatabase = 1;

    /// Start a separate Hyper with additional startup settings and run a test with it.
    async function withHyper(settings: Record<string, unknown>, test: (database: HyperDB) => Promise<void>): Promise<void> {
        const client = await createTestHyperDBClient(undefined, settings);
        try {
            const database = await HyperDB.create(new HyperDBEngine(client), {
                computeDatabasePath: `/mnt/fs/dashql-resource-metrics-${nextDatabase++}.hyper`,
                defaultDatabasePath: `/mnt/fs/dashql-resource-metrics-${nextDatabase++}.hyper`,
                terminateEngine: false,
            });
            try {
                await test(database);
            } finally {
                await database.terminate();
            }
        } finally {
            await client.terminate();
        }
    }

    /// Wait for the first resource-metrics events of the recorders and infer their schema.
    async function discoverSchema(settings: Record<string, unknown>): Promise<{
        schema: Record<string, string>;
        trackers: string[];
        errors: unknown[];
        sessions: string[];
        intervals: number[];
    }> {
        let discovered: Awaited<ReturnType<typeof discoverSchema>> | null = null;
        await withHyper({ ...RESOURCE_METRICS_SETTINGS, ...settings }, async database => {
            const connection = await database.connect();
            try {
                await waitForResourceMetrics(connection, 3);
                const events = await readResourceEvents(connection);
                const metrics = events.filter(event => event.k === 'resource-metrics');
                const last = metrics[metrics.length - 1].v as { 'mem-trackers': Record<string, Record<string, number>> };
                discovered = {
                    schema: inferJsonSchema(metrics.map(event => event.v)),
                    trackers: Object.keys(last['mem-trackers'].memory_tracked_current_usage_mb),
                    errors: events.filter(event => event.k !== 'resource-metrics').map(({ k, v }) => ({ k, v })),
                    sessions: [...new Set(metrics.map(event => event.sess))],
                    intervals: metrics.slice(1).map((event, i) => event.ts - metrics[i].ts),
                };
            } finally {
                await connection.close();
            }
        });
        return discovered!;
    }

    it('writes resource metrics with the default recorders', async () => {
        const { schema, trackers, errors, sessions, intervals } = await discoverSchema({});
        expect(errors).toEqual([]);
        // The events belong to no session, the log extract never drops them as events of a monitor.
        expect(sessions).toEqual(['-']);
        for (const interval of intervals) {
            expect(interval).toBeGreaterThan(500);
            expect(interval).toBeLessThan(3_000);
        }
        expect(schema).toEqual(DEFAULT_RESOURCE_METRICS_SCHEMA);
        expect(trackers).toEqual(expect.arrayContaining(['global', 'global_transactions', 'global_plan_cache']));
    }, 60_000);

    it('writes resource metrics with all recorders', async () => {
        const { schema, errors } = await discoverSchema({ log_resource_usage_mode: ALL_RESOURCE_RECORDERS });
        expect(errors).toEqual([]);
        expect(schema).toEqual(ALL_RECORDERS_RESOURCE_METRICS_SCHEMA);
    }, 60_000);

    it('extracts the resource metrics into typed columns', async () => {
        const sinkClient = await createTestHyperDBClient();
        const extractPath = `/mnt/fs/hyper_resource_metrics_${crypto.randomUUID().replace(/-/g, '_')}.hyper`;
        try {
            await withHyper(RESOURCE_METRICS_SETTINGS, async database => {
                const sinkDatabase = await HyperDB.create(new HyperDBEngine(sinkClient), {
                    computeDatabasePath: `/mnt/fs/dashql-resource-metrics-sink-${nextDatabase++}.hyper`,
                    defaultDatabasePath: `/mnt/fs/dashql-resource-metrics-sink-${nextDatabase++}.hyper`,
                    terminateEngine: false,
                });
                const worker = await database.connect();
                let extract: HyperDBIncrementalExtract | null = null;
                let reader: HyperDBConnection | null = null;
                try {
                    extract = await HyperDBIncrementalExtract.open({
                        sourceDatabase: database,
                        source: new HyperDBLogSource("SELECT * FROM log WHERE k = 'resource-metrics'"),
                        sink: sinkDatabase,
                        databasePath: extractPath,
                        tables: [HYPER_LOG_RESOURCE_METRICS_TABLE],
                    });
                    expect(extract.schemas.resource_metrics).toEqual([
                        { name: 'ts', type: 'timestamp' },
                        { name: 'process_memory_mb', type: 'double precision' },
                        { name: 'total_memory_mb', type: 'double precision' },
                        { name: 'transaction_memory_mb', type: 'double precision' },
                        { name: 'overall_load', type: 'double precision' },
                        { name: 'scheduler_load', type: 'double precision' },
                        { name: 'memory_load', type: 'double precision' },
                        { name: 'active_threads', type: 'integer' },
                        { name: 'waiting_jobs', type: 'integer' },
                    ]);
                    reader = await sinkDatabase.connect();
                    await reader.execute(`ATTACH DATABASE ${quoteIdentifier(extractPath)} AS extract_reader`);
                    const table = 'extract_reader.public.resource_metrics';

                    // Run the workload until a sample of the recorder falls into a query.
                    const deadline = performance.now() + 30_000;
                    while (await readNumber(reader, `SELECT count(*) AS n FROM ${table} WHERE transaction_memory_mb > 0`) === 0) {
                        if (performance.now() > deadline) throw new Error('no resource sample caught the workload in time');
                        await runWorkload(worker);
                        await extract.poll();
                    }
                    // Idle samples follow the workload.
                    await new Promise(resolve => setTimeout(resolve, 2_000));
                    await extract.poll();

                    const [metrics] = toPlainObjects(await reader.query(`
                        SELECT
                            count(*)                                         AS samples,
                            count(DISTINCT ts)                               AS timestamps,
                            min(process_memory_mb)                           AS min_process_memory_mb,
                            max(process_memory_mb)                           AS max_process_memory_mb,
                            max(transaction_memory_mb)                       AS peak_transaction_memory_mb,
                            max(total_memory_mb)                             AS total_memory_mb,
                            max(active_threads)                              AS max_active_threads,
                            max(overall_load)                                AS max_overall_load,
                            count(*) FILTER (WHERE transaction_memory_mb = 0) AS idle_samples,
                            count(*) FILTER (WHERE process_memory_mb < transaction_memory_mb) AS uncovered_samples
                        FROM ${table}
                    `));
                    expect(Number(metrics.samples)).toBeGreaterThanOrEqual(2);
                    // Polls read the resource events of the backfill overlap again, but store every event once.
                    expect(metrics.timestamps).toBe(metrics.samples);
                    expect(metrics.min_process_memory_mb).toBeGreaterThan(0);
                    expect(metrics.max_process_memory_mb).toBeGreaterThanOrEqual(metrics.min_process_memory_mb as number);
                    expect(metrics.peak_transaction_memory_mb).toBeGreaterThan(0);
                    expect(metrics.total_memory_mb).toBeGreaterThan(metrics.max_process_memory_mb as number);
                    expect(metrics.max_active_threads).toBeGreaterThan(0);
                    expect(metrics.max_overall_load).toBeGreaterThan(0);
                    expect(metrics.max_overall_load).toBeLessThanOrEqual(1);
                    expect(Number(metrics.idle_samples)).toBeGreaterThan(0);
                    // The Wasm memory holds the memory of the queries.
                    expect(Number(metrics.uncovered_samples)).toBe(0);
                } finally {
                    if (reader != null) {
                        await reader.execute('DETACH DATABASE extract_reader');
                        await reader.close();
                    }
                    await extract?.stop();
                    await worker.close();
                    const cleanup = await sinkDatabase.connect();
                    await cleanup.execute(`DROP DATABASE IF EXISTS ${quoteIdentifier(extractPath)}`);
                    await cleanup.close();
                    await sinkDatabase.terminate();
                }
            });
        } finally {
            await sinkClient.terminate();
        }
    }, 90_000);
});
