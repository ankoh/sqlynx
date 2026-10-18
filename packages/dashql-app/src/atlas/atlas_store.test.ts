import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyzeTable } from '../compute/computation_logic.js';
import { processTask } from '../compute/computation_scheduler.js';
import { createComputationState, reduceComputationState, type ComputationAction, type ComputationState } from '../compute/computation_state.js';
import { ORDINAL_COLUMN, STRING_COLUMN } from '../compute/computation_types.js';
import { DataFrameRegistry } from '../compute/data_frame.js';

import type { EmbeddedComputeDatabase, EmbeddedTableImportConnection } from '../platform/database/embedded_database.js';
import { setupWebHyperDB } from '../platform/hyperdb/hyperdb_provider_web.js';
import { TestLogger } from '../platform/logger/test_logger.js';
import { AtlasSql } from './atlas_sql.js';
import type { StructureFeatures } from './index/analysis/structure.js';
import { ATLAS_INDEX_FILE, ATLAS_STALE_FILES } from './index/files.js';
import type { LayoutResult } from './index/layout.js';
import type { IndexRow } from './index/rows.js';
import { LAYOUT_DIMS } from './index/tables.js';
import { DESCRIPTION_SEARCH, searchAll } from './search/search.js';
import {
    checkIndexModel,
    countOutdatedScripts,
    externalDirectoryDatabase,
    hasIndexFile,
    indexPoints,
    indexRowsTable,
    loadIndexedScripts,
    loadIndexTable,
    mountFolder,
    unmountFolder,
    writeIndexFile,
    type AtlasLocation,
    type IndexPoints,
} from './store.js';

const DIM = 384;
const EMBEDDER = { model: 'test/embedder', dim: DIM };

function basis(index: number, secondary?: number): Float32Array {
    const v = new Float32Array(DIM);
    v[index] = 1;
    if (secondary != null) {
        v[index] = Math.SQRT1_2;
        v[secondary] = Math.SQRT1_2;
    }
    return v;
}

function features(tables: string[]): StructureFeatures {
    return {
        statementTypes: ['select'],
        tables,
        columns: [],
        functions: [],
        aggregates: [],
        functionCalls: ['sum(x)'],
        ctes: [],
        joins: [],
        filters: [],
        operators: [],
        outputColumns: [],
        groupBy: [],
        orderBy: [],
        visualizations: [],
    };
}

describe('atlas store and search', () => {
    let database: EmbeddedComputeDatabase;
    let connection: EmbeddedTableImportConnection;
    let sql: AtlasSql;
    let root: FileSystemDirectoryHandle;
    let directory: FileSystemDirectoryHandle;
    let directoryName: string;
    let location: AtlasLocation;

    beforeAll(async () => {
        database = await setupWebHyperDB('atlas_store_test', new TestLogger());
        connection = await database.connect() as EmbeddedTableImportConnection;
        sql = new AtlasSql(connection, { dispatch: () => {} });
        root = await navigator.storage.getDirectory();
        directoryName = `dashql-atlas-${crypto.randomUUID()}`;
        directory = await root.getDirectoryHandle(directoryName, { create: true });
        location = await mountFolder(externalDirectoryDatabase(database)!, directory);
    }, 120_000);

    afterAll(async () => {
        try {
            await unmountFolder(externalDirectoryDatabase(database)!);
        } catch {
            // The mount may already be gone
        }
        await connection?.close();
        await database?.terminate();
        await root?.removeEntry(directoryName, { recursive: true }).catch(() => {});
    });

    const finance = { owner: 'finance', dashboard: 'Revenue Weekly', avg_runtime_ms: 1834.5, text: 'no clash' };
    /// script_1 has two description chunks, script_3 could not be analyzed
    const rows: IndexRow[] = [
        {
            scriptName: 'script_1.sql',
            scriptHash: 'hash_1',
            chunkIndex: 0,
            text: 'Revenue per customer',
            embedding: basis(100),
            features: features(['table_1']),
            diagnostics: [],
            metadata: finance,
        },
        {
            scriptName: 'script_1.sql',
            scriptHash: 'hash_1',
            chunkIndex: 1,
            text: 'Orders per region',
            embedding: basis(101),
            features: features(['table_1']),
            diagnostics: [],
            metadata: finance,
        },
        {
            scriptName: 'script_2.sql',
            scriptHash: 'hash_2',
            chunkIndex: 0,
            text: 'Top suppliers',
            embedding: basis(102),
            features: features(['table_2', 'table_3']),
            diagnostics: [],
            metadata: { owner: 'sales', tags: ['a', 'b'] },
        },
        {
            scriptName: 'script_3.sql',
            scriptHash: 'hash_3',
            chunkIndex: 0,
            text: 'Late shipments',
            embedding: basis(103),
            features: null,
            diagnostics: ['syntax error'],
            metadata: null,
        },
    ];
    /// Row i is at `i / 10`
    const layout = (count: number): LayoutResult => ({
        coords: new Float32Array(count * LAYOUT_DIMS).map((_, i) => i / 10),
        scale: 1,
        mode: 'trivial',
        uniqueVectors: count,
    });

    it('finds no index file in a new folder', async () => {
        expect(await hasIndexFile(directory)).toBe(false);
        await expect(loadIndexTable(sql, location)).rejects.toThrow();
    }, 60_000);

    it('writes a Parquet file into the folder and reads it back', async () => {
        // A file of an earlier format version is removed
        const stale = await directory.getFileHandle(ATLAS_STALE_FILES[0], { create: true });
        const writable = await stale.createWritable();
        await writable.close();
        await writeIndexFile(sql, location, rows, layout(rows.length), EMBEDDER);
        await expect(directory.getFileHandle(ATLAS_STALE_FILES[0])).rejects.toThrow();

        // The file is a real file of the selected folder, not only visible to Hyper
        expect((await (await directory.getFileHandle(ATLAS_INDEX_FILE)).getFile()).size).toBeGreaterThan(0);
        expect(await hasIndexFile(directory)).toBe(true);

        const table = await sql.query('Read back', `
            SELECT script_name, description_chunk_index, description_embedding, description_x, structure_table_names
            FROM external('${location.path}') ORDER BY script_name, description_chunk_index`);
        expect(table.numRows).toBe(4);
        const script2 = table.toArray().find(r => r.script_name === 'script_2.sql');
        expect(script2.structure_table_names.toArray()).toEqual(['table_2', 'table_3']);
        const models = await sql.query('Read back models', `
            SELECT DISTINCT description_embedding_model AS model FROM external('${location.path}')`);
        expect(models.toArray().map(r => r.model)).toEqual(['test/embedder']);

        // Every chunk carries the structure of its script, the counts of a script without analysis are null
        const counts = await sql.query('Read back counts', `
            SELECT structure_table_count, structure_function_call_count, structure_cte_count, structure_diagnostic_count
            FROM external('${location.path}') ORDER BY script_name, description_chunk_index`);
        const count = (tables: number | null, calls: number | null, ctes: number | null, diagnostics: number) => ({
            structure_table_count: tables,
            structure_function_call_count: calls,
            structure_cte_count: ctes,
            structure_diagnostic_count: diagnostics,
        });
        expect(counts.toArray().map(r => ({ ...r }))).toEqual([
            count(1, 1, 0, 0),
            count(1, 1, 0, 0),
            count(2, 1, 0, 0),
            count(null, null, null, 1),
        ]);
        const columns = (await sql.query('Columns', `SELECT * FROM external('${location.path}') LIMIT 1`))
            .schema.fields.map(f => f.name);
        // script_, description_, metadata_ and structure_ columns in this order, every list next to its count
        expect(columns).toEqual([
            'script_name',
            'script_hash',
            'description_chunk_index',
            'description_chunk',
            'description_embedding',
            'description_embedding_model',
            'description_x',
            'description_y',
            'description_z',
            'metadata_owner',
            'metadata_dashboard',
            'metadata_avg_runtime_ms',
            'metadata_text',
            'metadata_tags',
            'structure_statement_count',
            'structure_statement_types',
            'structure_table_count',
            'structure_table_names',
            'structure_column_count',
            'structure_column_names',
            'structure_function_count',
            'structure_function_names',
            'structure_aggregate_count',
            'structure_aggregate_names',
            'structure_function_call_count',
            'structure_function_call_expressions',
            'structure_cte_count',
            'structure_cte_names',
            'structure_join_conditions',
            'structure_filter_count',
            'structure_filter_predicates',
            'structure_operator_names',
            'structure_visualization_count',
            'structure_visualization_summaries',
            'structure_diagnostic_count',
            'structure_diagnostic_messages',
        ]);

        // Every metadata key is a column, typed by its values, rows without the key are null
        const metadata = await sql.query('Read back metadata', `
            SELECT metadata_owner AS owner, metadata_dashboard AS dashboard, metadata_avg_runtime_ms AS avg_runtime_ms,
                metadata_tags AS tags, metadata_text AS text
            FROM external('${location.path}') ORDER BY script_name, description_chunk_index`);
        expect(metadata.toArray().map(r => ({ ...r }))).toEqual([
            { owner: 'finance', dashboard: 'Revenue Weekly', avg_runtime_ms: 1834.5, tags: null, text: 'no clash' },
            { owner: 'finance', dashboard: 'Revenue Weekly', avg_runtime_ms: 1834.5, tags: null, text: 'no clash' },
            { owner: 'sales', dashboard: null, avg_runtime_ms: null, tags: '["a","b"]', text: null },
            { owner: null, dashboard: null, avg_runtime_ms: null, tags: null, text: null },
        ]);
        // Numeric metadata stays doubles, only the vectors are written as real
        expect(metadata.schema.fields.find(f => f.name === 'avg_runtime_ms')!.type.toString()).toBe('Float64');
    }, 120_000);

    it('loads a point for every description chunk', async () => {
        const xOf = (points: IndexPoints, script: string) =>
            Array.from(points.owners, (owner, i) => points.scripts[owner] === script ? points.coords[i * LAYOUT_DIMS] : null)
                .filter((x): x is number => x != null)
                .sort((a, b) => a - b);

        const table = await loadIndexTable(sql, location);
        expect(table.schema.fields.map(f => f.name)).not.toContain('description_embedding');
        const points = indexPoints(table);
        expect(points.scripts.slice().sort()).toEqual(['script_1.sql', 'script_2.sql', 'script_3.sql']);
        expect(points.owners).toHaveLength(4);
        expect(points.coords).toHaveLength(4 * LAYOUT_DIMS);
        expect(xOf(points, 'script_1.sql')).toHaveLength(2);
        // Rows were written with the values i / 10, row 2 starts at 6
        expect(xOf(points, 'script_2.sql')[0]).toBeCloseTo(0.6, 4);
        // Every point says what it is about, the description chunk and the tables of its script
        expect(points.details.slice().sort())
            .toEqual(['Late shipments', 'Orders per region', 'Revenue per customer', 'Top suppliers']);
        const script2 = points.owners.indexOf(points.scripts.indexOf('script_2.sql'));
        expect(points.tables[script2]).toEqual(['table_2', 'table_3']);
        expect(points.tables[points.owners.indexOf(points.scripts.indexOf('script_3.sql'))]).toEqual([]);

        // The rows leave out what only the cloud needs
        const shown = indexRowsTable(table).schema.fields.map(f => f.name);
        expect(shown.slice(0, 9)).toEqual([
            'script_name',
            'description_chunk_index',
            'description_chunk',
            'description_embedding_model',
            'metadata_owner',
            'metadata_dashboard',
            'metadata_avg_runtime_ms',
            'metadata_text',
            'metadata_tags',
        ]);
        expect(shown).toContain('structure_table_count');
        expect(shown).toContain('structure_table_names');
        expect(shown).not.toContain('script_hash');
        expect(shown).not.toContain('description_x');
    }, 60_000);

    it('reports index files without the count columns as unreadable', async () => {
        const directoryPath = location.path.slice(0, location.path.lastIndexOf('/'));
        const old = { ...location, path: `${directoryPath}/old-index.parquet` };
        await sql.run('Write old index', `
            COPY (SELECT script_name, script_hash, description_chunk, structure_table_names,
                    description_x, description_y, description_z
                  FROM external('${location.path}')) TO '${old.path}' WITH (FORMAT PARQUET)`);
        await expect(loadIndexTable(sql, old)).rejects.toThrow(/structure_table_count/);
        await directory.removeEntry('old-index.parquet');
    }, 60_000);

    it('reports index files of another model as unreadable', async () => {
        await expect(checkIndexModel(sql, location, EMBEDDER.model)).resolves.toBeUndefined();
        await expect(checkIndexModel(sql, location, 'other/embedder')).rejects.toThrow(/test\/embedder.*other\/embedder/);
    }, 60_000);

    it('analyzes the rows of the index file with histograms', async () => {
        // The registry and the scheduler of the page, without React
        const logger = new TestLogger();
        const memory = new DataFrameRegistry(logger);
        let state: ComputationState = createComputationState();
        const launched = new Set<number>();
        const dispatch = (action: ComputationAction) => {
            state = reduceComputationState(state, action, memory, logger);
            for (const [id, task] of Object.entries(state.schedulerTasks)) {
                if (launched.has(+id)) continue;
                launched.add(+id);
                void processTask(task, dispatch, logger);
            }
        };
        await analyzeTable(1, indexRowsTable(await loadIndexTable(sql, location)), dispatch, database, logger);
        const table = state.tableComputations[1]!;
        expect(table.dataTable.schema.fields.map(f => f.name)).toContain(table.rowNumberColumnName);
        const kinds = new Map<string, symbol | undefined>();
        table.columnGroups.forEach((group, i) => {
            if (group.type !== ORDINAL_COLUMN && group.type !== STRING_COLUMN) return;
            kinds.set(group.value.inputFieldName, table.columnAggregates[i]?.type);
        });

        // The feature lists survive the data frame
        const row = table.dataTable.toArray().find(r => r.script_name === 'script_2.sql');
        expect(Array.from(row.structure_table_names ?? [])).toEqual(['table_2', 'table_3']);
        expect(kinds.get('structure_table_count')).toBe(ORDINAL_COLUMN);
        expect(kinds.get('script_name')).toBe(STRING_COLUMN);
        expect(kinds.get('metadata_avg_runtime_ms')).toBe(ORDINAL_COLUMN);
        expect(kinds.get('metadata_owner')).toBe(STRING_COLUMN);
    }, 120_000);

    it('finds the best description chunk of a script', async () => {
        const hits = await DESCRIPTION_SEARCH.run(sql, location, basis(101, 102), 5);
        expect(hits.map(h => h.scriptName).slice(0, 2).sort()).toEqual(['script_1.sql', 'script_2.sql']);
        const byName = new Map(hits.map(h => [h.scriptName, h]));
        // script_1 has two chunks, the better one of them is reported
        expect(byName.get('script_1.sql')!.snippet).toBe('Orders per region');
        expect(byName.get('script_1.sql')!.score).toBeCloseTo(Math.SQRT1_2, 4);
        expect(byName.get('script_2.sql')!.snippet).toBe('Top suppliers');
    }, 60_000);

    it('knows the scripts and hashes of the index', async () => {
        const indexed = await loadIndexedScripts(sql, location);
        expect(indexed.size).toBe(3);
        expect(indexed.get('script_2.sql')).toBe('hash_2');
        const current = new Map(indexed);
        expect(countOutdatedScripts(indexed, current)).toBe(0);
        current.set('script_2.sql', 'changed');
        current.set('new.sql', 'hash');
        current.delete('script_1.sql');
        expect(countOutdatedScripts(indexed, current)).toBe(3);
    }, 60_000);

    it('runs all strategies for one query', async () => {
        const results = await searchAll(sql, location, basis(103));
        expect(results.map(r => r.strategy.id)).toEqual(['description']);
        expect(results[0].hits[0].scriptName).toBe('script_3.sql');
    }, 60_000);

    it('replaces an existing index file', async () => {
        await writeIndexFile(sql, location, rows.slice(0, 1), layout(1), EMBEDDER);
        const table = await sql.query('Count', `SELECT count(*) AS n FROM external('${location.path}')`);
        expect(Number(table.toArray()[0].n)).toBe(1);
        await writeIndexFile(sql, location, [], layout(0), EMBEDDER);
        const empty = await sql.query('Count', `SELECT count(*) AS n FROM external('${location.path}')`);
        expect(Number(empty.toArray()[0].n)).toBe(0);
    }, 120_000);
});
