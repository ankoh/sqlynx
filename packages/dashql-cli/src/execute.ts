import { buffers, type DashQL } from '@ankoh/dashql-core';
import { HyperDB, HyperDBError, type HyperDBConnection } from 'hyperdb-wasm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/// The outcome of executing one script
export type Execution = ExecutionSuccess | ExecutionFailure;

/// Every statement succeeded. `rows` counts the result of the final statement, absent if it has no result.
export interface ExecutionSuccess {
    ok: true;
    statements: number;
    rows?: number;
    timings: ExecutionTimings;
}

/// Statement `statement` (1-based) or, without it, the compilation of the script failed
export interface ExecutionFailure {
    ok: false;
    message: string;
    statement?: number;
    sqlState?: string;
    detail?: string;
    hint?: string;
    timings: ExecutionTimings;
}

/// Where the time of a script went, in milliseconds
export interface ExecutionTimings {
    /// Analysis and compilation of the script in dashql-core
    core: number;
    /// The statements that were sent to Hyper, up to the failing one
    statements: StatementTiming[];
}

export interface StatementTiming {
    /// From sending the statement until its result and query info arrived
    wall: number;
    /// What Hyper reports for the statement, absent if it failed
    hyper?: { elapsed: number | null; parsing: number | null; compilation: number | null; execution: number | null };
}

const millis = (seconds: number | null) => (seconds === null ? null : seconds * 1000);

/// The engine settings of the app, see packages/dashql-app/src/platform/hyperdb/hyperdb_settings.ts.
/// Scripts may load data over HTTP like they do in the app.
const SETTINGS = {
    default_database_version: 3,
    identifier_resolution: 'case_insensitive',
    experimental_view_creation: true,
    experimental_persisted_view_creation: true,
    experimental_hyper_introspection_functions: true,
    experimental_data_type_persistence: true,
    experimental_multidimensional_arrays: true,
    experimental_external_http_location: true,
    experimental_external_metaquery: true,
    experimental_persisted_external_tables: true,
    raw_sql_format_table_scan: true,
    http_location_allowlist: ['*'],
    // No log file, Hyper would announce its path on stdout
    log_config: '',
};

/// Like the app, scripts create their tables in an attached database.
/// /mnt/fs is the storage directory of the engine, a temporary directory that is removed on close.
const DATABASE_PATH = '/mnt/fs/dashql-cli.hyper';

/// Only affects how VISUALIZE queries are formatted, any valid config works
const FORMATTING = new buffers.formatting.FormattingConfigT(
    buffers.formatting.FormattingDialect.HYPER,
    buffers.formatting.FormattingMode.INLINE,
    120,
    2,
    false,
);

function failure(timings: ExecutionTimings, error: unknown, statement?: number): ExecutionFailure {
    const out: ExecutionFailure = { ok: false, message: error instanceof Error ? error.message : String(error), timings };
    if (statement !== undefined) out.statement = statement;
    if (error instanceof HyperDBError) {
        out.sqlState = error.sqlState || undefined;
        out.detail = error.detail || undefined;
        out.hint = error.hint || undefined;
    }
    return out;
}

/// Executes scripts statement by statement in an in-memory Hyper database.
/// All scripts share one connection, so later scripts see the tables of earlier ones.
export class Executor {
    private constructor(
        readonly core: DashQL,
        readonly database: HyperDB,
        readonly connection: HyperDBConnection,
        readonly storagePath: string,
    ) {}

    static async create(core: DashQL): Promise<Executor> {
        // Without a storage path the engine would write into the working directory
        const storagePath = await mkdtemp(join(tmpdir(), 'dashql-cli-'));
        let database: HyperDB | null = null;
        try {
            database = await HyperDB.create({ storagePath, settings: SETTINGS });
            const connection = await database.connect();
            await connection.query(`create database "${DATABASE_PATH}"`).result;
            await connection.query(`attach database "${DATABASE_PATH}" as hyper`).result;
            return new Executor(core, database, connection, storagePath);
        } catch (error) {
            await database?.terminate();
            await rm(storagePath, { recursive: true, force: true });
            throw error;
        }
    }

    /// Compile the script into its statements like the app does and run them one after the other.
    /// Results are not materialized, only the rows of the final statement are counted.
    async execute(text: string): Promise<Execution> {
        const timings: ExecutionTimings = { core: 0, statements: [] };
        let statements: { sql: string; output: boolean }[];
        const coreStart = performance.now();
        const catalog = this.core.createCatalog();
        const script = this.core.createScript(catalog);
        try {
            script.replaceText(text);
            script.analyze();
            const compiled = script.compileQuery(FORMATTING);
            try {
                const reader = compiled.read();
                if (reader.errorsLength() > 0) {
                    const error = reader.errors(0)!;
                    // Scripts with comments only are fine, there is just nothing to run
                    if (error.code() === buffers.execution.ScriptCompilationErrorCode.EMPTY_SCRIPT) {
                        return { ok: true, statements: 0, timings };
                    }
                    return failure(timings, error.message() ?? 'could not compile the script');
                }
                statements = Array.from({ length: reader.statementsLength() }, (_, i) => {
                    const statement = reader.statements(i)!;
                    return {
                        sql: statement.sql() ?? '',
                        output: statement.kind() !== buffers.execution.CompiledScriptStatementKind.COMMAND,
                    };
                });
            } finally {
                compiled.destroy();
            }
        } catch (error) {
            return failure(timings, error);
        } finally {
            script.destroy();
            catalog.destroy();
            timings.core = performance.now() - coreStart;
        }

        let rows: number | undefined;
        for (let i = 0; i < statements.length; ++i) {
            const start = performance.now();
            try {
                const query = this.connection.queryIPC(statements[i].sql);
                await query.result;
                const info = await query.info;
                if (statements[i].output && info.rowCount !== null) rows = Number(info.rowCount);
                const t = info.timings;
                timings.statements.push({
                    wall: performance.now() - start,
                    hyper: {
                        elapsed: millis(t.elapsedSeconds),
                        parsing: millis(t.parsingSeconds),
                        compilation: millis(t.compilationSeconds),
                        execution: millis(t.executionSeconds),
                    },
                });
            } catch (error) {
                timings.statements.push({ wall: performance.now() - start });
                return failure(timings, error, i + 1);
            }
        }
        return { ok: true, statements: statements.length, rows, timings };
    }

    async close(): Promise<void> {
        try {
            await this.connection.close();
        } finally {
            await this.database.terminate();
            await rm(this.storagePath, { recursive: true, force: true });
        }
    }
}
