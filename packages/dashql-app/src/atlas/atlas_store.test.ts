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
import { ATLAS_DESCRIPTION_FILE, ATLAS_PROPERTIES_FILE, ATLAS_STALE_FILES, ATLAS_STRUCTURE_FILE } from './index/files.js';
import type { EmbeddingKind } from './index/indexer.js';
import type { LayoutResult } from './index/layout.js';
import type { DescriptionRow, PropertiesRow, StructureRow } from './index/rows.js';
import { LAYOUT_DIMS } from './index/tables.js';
import { DESCRIPTION_SEARCH, PROPERTIES_SEARCH, STRUCTURE_SEARCH, searchAll } from './search/search.js';
import {
    countOutdatedScripts,
    externalDirectoryDatabase,
    hasIndexFiles,
    indexPoints,
    indexRowsTable,
    loadIndexedScripts,
    loadIndexTable,
    mountFolder,
    unmountFolder,
    writeIndexFiles,
    type AtlasLocation,
    type IndexPoints,
} from './store.js';

const DIM = 384;

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

    const structureRows: StructureRow[] = Array.from({ length: 12 }, (_, i) => ({
        scriptName: `script_${i}.sql`,
        scriptHash: `hash_${i}`,
        truncated: false,
        embedding: basis(i),
        features: features([`table_${i}`]),
        diagnostics: [],
    }));
    const descriptionRows: DescriptionRow[] = [
        { scriptName: 'script_3.sql', scriptHash: 'hash_3', chunkIndex: 0, text: 'Revenue per customer', embedding: basis(100) },
        { scriptName: 'script_3.sql', scriptHash: 'hash_3', chunkIndex: 1, text: 'Orders per region', embedding: basis(101) },
        { scriptName: 'script_7.sql', scriptHash: 'hash_7', chunkIndex: 0, text: 'Top suppliers', embedding: basis(102) },
    ];
    const propertiesRows: PropertiesRow[] = [
        {
            scriptName: 'script_1.sql',
            scriptHash: 'hash_1',
            properties: { owner: 'finance', dashboard: 'Revenue Weekly', avg_runtime_ms: 1834.5, text: 'clashes' },
            text: 'owner: finance\ndashboard: Revenue Weekly',
            truncated: false,
            embedding: basis(200),
        },
        {
            scriptName: 'script_2.sql',
            scriptHash: 'hash_2',
            properties: { owner: 'sales', tags: ['a', 'b'] },
            text: 'owner: sales',
            truncated: false,
            embedding: basis(201),
        },
    ];
    /// Every file has its own layout, the rows of a kind are at `base + i / 10`
    const layout = (rows: number, base: number): LayoutResult => ({
        coords: new Float32Array(rows * LAYOUT_DIMS).map((_, i) => base + i / 10),
        scale: 1,
        mode: 'trivial',
        uniqueVectors: rows,
    });
    const layouts = (): Record<EmbeddingKind, LayoutResult> => ({
        structure: layout(structureRows.length, 0),
        description: layout(descriptionRows.length, 100),
        properties: layout(propertiesRows.length, 200),
    });

    it('finds no index files in a new folder', async () => {
        expect(await hasIndexFiles(directory)).toBe(false);
        await expect(loadIndexTable(sql, location, 'structure')).rejects.toThrow();
    }, 60_000);

    it('writes Parquet files into the folder and reads them back', async () => {
        // A file of an earlier format version is removed
        const stale = await directory.getFileHandle(ATLAS_STALE_FILES[0], { create: true });
        const writable = await stale.createWritable();
        await writable.close();
        await writeIndexFiles(
            sql,
            location,
            { structure: structureRows, description: descriptionRows, properties: propertiesRows },
            layouts(),
            DIM,
        );
        await expect(directory.getFileHandle(ATLAS_STALE_FILES[0])).rejects.toThrow();

        // The files are real files of the selected folder, not only visible to Hyper
        expect((await (await directory.getFileHandle(ATLAS_STRUCTURE_FILE)).getFile()).size).toBeGreaterThan(0);
        expect((await (await directory.getFileHandle(ATLAS_DESCRIPTION_FILE)).getFile()).size).toBeGreaterThan(0);
        expect((await (await directory.getFileHandle(ATLAS_PROPERTIES_FILE)).getFile()).size).toBeGreaterThan(0);
        expect(await hasIndexFiles(directory)).toBe(true);

        const table = await sql.query('Read back', `
            SELECT script_name, dashql_atlas_embedding, dashql_atlas_x, tables FROM external('${location.paths.structure}') ORDER BY script_name`);
        expect(table.numRows).toBe(12);
        expect(table.toArray().find(r => r.script_name === 'script_7.sql').tables.toArray()).toEqual(['table_7']);
        const counts = await sql.query('Read back counts', `
            SELECT table_count, function_call_count, cte_count FROM external('${location.paths.structure}') ORDER BY script_name`);
        expect({ ...counts.toArray()[0] }).toEqual({ table_count: 1, function_call_count: 1, cte_count: 0 });
        expect(counts.schema.fields.map(f => f.name)).toHaveLength(3);
        const columns = (await sql.query('Structure columns', `SELECT * FROM external('${location.paths.structure}') LIMIT 1`))
            .schema.fields.map(f => f.name);
        expect(columns).not.toContain('join_count');
        expect(columns).not.toContain('operator_count');

        // Every property is a column, typed by its values, rows without the property are null
        const properties = await sql.query('Read back properties', `
            SELECT owner, dashboard, avg_runtime_ms, tags, property_text
            FROM external('${location.paths.properties}') ORDER BY script_name`);
        expect(properties.toArray().map(r => ({ ...r }))).toEqual([
            { owner: 'finance', dashboard: 'Revenue Weekly', avg_runtime_ms: 1834.5, tags: null, property_text: 'clashes' },
            { owner: 'sales', dashboard: null, avg_runtime_ms: null, tags: '["a","b"]', property_text: null },
        ]);
        // Numeric properties stay doubles, only the vectors are written as real
        expect(properties.schema.fields.find(f => f.name === 'avg_runtime_ms')!.type.toString()).toBe('Float64');
    }, 120_000);

    it('loads a point for every structure row, description chunk and properties row', async () => {
        const xOf = (points: IndexPoints, script: string) =>
            Array.from(points.owners, (owner, i) => points.scripts[owner] === script ? points.coords[i * LAYOUT_DIMS] : null)
                .filter((x): x is number => x != null)
                .sort((a, b) => a - b);

        const structureTable = await loadIndexTable(sql, location, 'structure');
        expect(structureTable.schema.fields.map(f => f.name)).not.toContain('dashql_atlas_embedding');
        const features = indexPoints(structureTable, 'structure');
        expect(features.scripts).toHaveLength(12);
        expect(features.owners).toHaveLength(12);
        expect(features.coords).toHaveLength(12 * LAYOUT_DIMS);
        // Rows were written with the values i / 10, structure row 7 starts at 21
        expect(xOf(features, 'script_7.sql')).toHaveLength(1);
        expect(xOf(features, 'script_7.sql')[0]).toBeCloseTo(2.1, 4);
        // Every point says what it is about, the structure by its tables
        expect(features.details).toHaveLength(12);
        expect(features.details[features.owners.indexOf(features.scripts.indexOf('script_7.sql'))]).toBe('table_7');

        const comments = indexPoints(await loadIndexTable(sql, location, 'description'), 'description');
        expect(comments.scripts.sort()).toEqual(['script_3.sql', 'script_7.sql']);
        expect(comments.owners).toHaveLength(3);
        expect(xOf(comments, 'script_3.sql')).toHaveLength(2);
        expect(comments.details.slice().sort()).toEqual(['Orders per region', 'Revenue per customer', 'Top suppliers']);
        // Description row 2 starts at 6 in the layout of the descriptions
        expect(xOf(comments, 'script_7.sql')[0]).toBeCloseTo(100.6, 3);

        const propertiesTable = await loadIndexTable(sql, location, 'properties');
        const properties = indexPoints(propertiesTable, 'properties');
        expect(properties.scripts.sort()).toEqual(['script_1.sql', 'script_2.sql']);
        expect(properties.details).toContain('owner: sales');
        expect(xOf(properties, 'script_2.sql')[0]).toBeCloseTo(200.3, 3);

        // The rows leave out what only the cloud needs
        expect(indexRowsTable(propertiesTable).schema.fields.map(f => f.name))
            .toEqual(['script_name', 'truncated', 'owner', 'dashboard', 'avg_runtime_ms', 'property_text', 'tags', 'text']);
    }, 60_000);

    it('reports structure files without count columns as unreadable', async () => {
        const directoryPath = location.paths.structure.slice(0, location.paths.structure.lastIndexOf('/'));
        const old = { ...location, paths: { ...location.paths, structure: `${directoryPath}/old-structure.parquet` } };
        await sql.run('Write old structure', `
            COPY (SELECT script_name, script_hash, tables, dashql_atlas_x, dashql_atlas_y, dashql_atlas_z
                  FROM external('${location.paths.structure}')) TO '${old.paths.structure}' WITH (FORMAT PARQUET)`);
        await expect(loadIndexTable(sql, old, 'structure')).rejects.toThrow(/table_count/);
        await directory.removeEntry('old-structure.parquet');
    }, 60_000);

    it('analyzes the rows of the index files with histograms', async () => {
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
        const groupKinds = async (tableId: number, kind: EmbeddingKind) => {
            const rows = indexRowsTable(await loadIndexTable(sql, location, kind));
            await analyzeTable(tableId, rows, dispatch, database, logger);
            const table = state.tableComputations[tableId]!;
            const fields = table.dataTable.schema.fields.map(f => f.name);
            const kinds = new Map<string, symbol | undefined>();
            table.columnGroups.forEach((group, i) => {
                if (group.type !== ORDINAL_COLUMN && group.type !== STRING_COLUMN) return;
                kinds.set(group.value.inputFieldName, table.columnAggregates[i]?.type);
            });
            expect(fields).toContain(table.rowNumberColumnName);
            return kinds;
        };

        const structure = await groupKinds(1, 'structure');
        // The feature lists survive the data frame
        const analyzed = state.tableComputations[1]!.dataTable;
        const row = analyzed.toArray().find(r => r.script_name === 'script_7.sql');
        expect(Array.from(row.tables ?? [])).toEqual(['table_7']);
        expect(structure.get('table_count')).toBe(ORDINAL_COLUMN);
        expect(structure.get('script_name')).toBe(STRING_COLUMN);
        const properties = await groupKinds(2, 'properties');
        expect(properties.get('avg_runtime_ms')).toBe(ORDINAL_COLUMN);
        expect(properties.get('owner')).toBe(STRING_COLUMN);
    }, 120_000);

    it('finds the most similar script by structure', async () => {
        const hits = await STRUCTURE_SEARCH.run(sql, location, basis(5), 3);
        expect(hits).toHaveLength(3);
        expect(hits[0].scriptName).toBe('script_5.sql');
        expect(hits[0].score).toBeCloseTo(1, 4);
        expect(hits[0].snippet).toContain('table_5');
        expect(hits[1].score).toBeLessThan(0.5);
    }, 60_000);

    it('finds the best description chunk of a script', async () => {
        const hits = await DESCRIPTION_SEARCH.run(sql, location, basis(101, 102), 5);
        expect(hits.map(h => h.scriptName).sort()).toEqual(['script_3.sql', 'script_7.sql']);
        const byName = new Map(hits.map(h => [h.scriptName, h]));
        // script_3 has two chunks, the better one of them is reported
        expect(byName.get('script_3.sql')!.snippet).toBe('Orders per region');
        expect(byName.get('script_3.sql')!.score).toBeCloseTo(Math.SQRT1_2, 4);
        expect(byName.get('script_7.sql')!.snippet).toBe('Top suppliers');
    }, 60_000);

    it('knows the scripts and hashes of the index', async () => {
        const indexed = await loadIndexedScripts(sql, location);
        expect(indexed.size).toBe(12);
        expect(indexed.get('script_7.sql')).toBe('hash_7');
        const current = new Map(indexed);
        expect(countOutdatedScripts(indexed, current)).toBe(0);
        current.set('script_7.sql', 'changed');
        current.set('new.sql', 'hash');
        current.delete('script_1.sql');
        expect(countOutdatedScripts(indexed, current)).toBe(3);
    }, 60_000);

    it('finds scripts by their properties', async () => {
        const hits = await PROPERTIES_SEARCH.run(sql, location, basis(200), 5);
        expect(hits[0].scriptName).toBe('script_1.sql');
        expect(hits[0].score).toBeCloseTo(1, 4);
        expect(hits[0].snippet).toBe('owner: finance\ndashboard: Revenue Weekly');
    }, 60_000);

    it('runs all strategies for one query', async () => {
        const results = await searchAll(sql, location, basis(3));
        expect(results.map(r => r.strategy.id)).toEqual(['description', 'structure', 'properties']);
        expect(results[1].hits[0].scriptName).toBe('script_3.sql');
    }, 60_000);

    it('replaces existing index files', async () => {
        await writeIndexFiles(
            sql,
            location,
            { structure: structureRows.slice(0, 2), description: [], properties: [] },
            { structure: layout(2, 0), description: layout(0, 0), properties: layout(0, 0) },
            DIM,
        );
        const table = await sql.query('Count', `SELECT count(*) AS n FROM external('${location.paths.structure}')`);
        expect(Number(table.toArray()[0].n)).toBe(2);
        const empty = await sql.query('Count', `SELECT count(*) AS n FROM external('${location.paths.properties}')`);
        expect(Number(empty.toArray()[0].n)).toBe(0);
    }, 120_000);
});
