import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EmbeddedComputeDatabase, EmbeddedTableImportConnection } from '../platform/database/embedded_database.js';
import { setupWebHyperDB } from '../platform/hyperdb/hyperdb_provider_web.js';
import { TestLogger } from '../platform/logger/test_logger.js';
import { AtlasSql } from './atlas_sql.js';
import type { SyntaxFeatures } from './index/analysis/syntax.js';
import { ATLAS_DESCRIPTION_FILE, ATLAS_PROPERTIES_FILE, ATLAS_STALE_FILES, ATLAS_SYNTAX_FILE } from './index/files.js';
import type { EmbeddingKind } from './index/indexer.js';
import type { LayoutResult } from './index/layout.js';
import type { DescriptionRow, PropertiesRow, SyntaxRow } from './index/rows.js';
import { LAYOUT_DIMS } from './index/tables.js';
import { DESCRIPTION_SEARCH, PROPERTIES_SEARCH, SYNTAX_SEARCH, searchAll } from './search/search.js';
import {
    countOutdatedScripts,
    externalDirectoryDatabase,
    hasIndexFiles,
    loadIndexedScripts,
    loadIndexPoints,
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

function features(tables: string[]): SyntaxFeatures {
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

    const syntaxRows: SyntaxRow[] = Array.from({ length: 12 }, (_, i) => ({
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
            properties: '{"owner":"finance","dashboard":"Revenue Weekly"}',
            text: 'owner: finance\ndashboard: Revenue Weekly',
            truncated: false,
            embedding: basis(200),
        },
        {
            scriptName: 'script_2.sql',
            scriptHash: 'hash_2',
            properties: '{"owner":"sales"}',
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
        syntax: layout(syntaxRows.length, 0),
        description: layout(descriptionRows.length, 100),
        properties: layout(propertiesRows.length, 200),
    });

    it('finds no index files in a new folder', async () => {
        expect(await hasIndexFiles(directory)).toBe(false);
        await expect(loadIndexPoints(sql, location, 'syntax')).rejects.toThrow();
    }, 60_000);

    it('writes Parquet files into the folder and reads them back', async () => {
        // A file of an earlier format version is removed
        const stale = await directory.getFileHandle(ATLAS_STALE_FILES[0], { create: true });
        const writable = await stale.createWritable();
        await writable.close();
        await writeIndexFiles(
            sql,
            location,
            { syntax: syntaxRows, description: descriptionRows, properties: propertiesRows },
            layouts(),
            DIM,
        );
        await expect(directory.getFileHandle(ATLAS_STALE_FILES[0])).rejects.toThrow();

        // The files are real files of the selected folder, not only visible to Hyper
        expect((await (await directory.getFileHandle(ATLAS_SYNTAX_FILE)).getFile()).size).toBeGreaterThan(0);
        expect((await (await directory.getFileHandle(ATLAS_DESCRIPTION_FILE)).getFile()).size).toBeGreaterThan(0);
        expect((await (await directory.getFileHandle(ATLAS_PROPERTIES_FILE)).getFile()).size).toBeGreaterThan(0);
        expect(await hasIndexFiles(directory)).toBe(true);

        const table = await sql.query('Read back', `
            SELECT script_name, dashql_atlas_embedding, dashql_atlas_x, tables FROM external('${location.paths.syntax}') ORDER BY script_name`);
        expect(table.numRows).toBe(12);
        const properties = await sql.query('Read back properties', `
            SELECT properties FROM external('${location.paths.properties}') WHERE script_name = 'script_1.sql'`);
        expect(JSON.parse(String(properties.toArray()[0].properties))).toEqual({ owner: 'finance', dashboard: 'Revenue Weekly' });
    }, 120_000);

    it('loads a point for every syntax row, description chunk and properties row', async () => {
        const xOf = (points: IndexPoints, script: string) =>
            Array.from(points.owners, (owner, i) => points.scripts[owner] === script ? points.coords[i * LAYOUT_DIMS] : null)
                .filter((x): x is number => x != null)
                .sort((a, b) => a - b);

        const features = await loadIndexPoints(sql, location, 'syntax');
        expect(features.scripts).toHaveLength(12);
        expect(features.owners).toHaveLength(12);
        expect(features.coords).toHaveLength(12 * LAYOUT_DIMS);
        // Rows were written with the values i / 10, syntax row 7 starts at 21
        expect(xOf(features, 'script_7.sql')).toHaveLength(1);
        expect(xOf(features, 'script_7.sql')[0]).toBeCloseTo(2.1, 4);
        // Every point says what it is about, the syntax by its tables
        expect(features.details).toHaveLength(12);
        expect(features.details[features.owners.indexOf(features.scripts.indexOf('script_7.sql'))]).toBe('table_7');

        const comments = await loadIndexPoints(sql, location, 'description');
        expect(comments.scripts.sort()).toEqual(['script_3.sql', 'script_7.sql']);
        expect(comments.owners).toHaveLength(3);
        expect(xOf(comments, 'script_3.sql')).toHaveLength(2);
        expect(comments.details.slice().sort()).toEqual(['Orders per region', 'Revenue per customer', 'Top suppliers']);
        // Description row 2 starts at 6 in the layout of the descriptions
        expect(xOf(comments, 'script_7.sql')[0]).toBeCloseTo(100.6, 3);

        const properties = await loadIndexPoints(sql, location, 'properties');
        expect(properties.scripts.sort()).toEqual(['script_1.sql', 'script_2.sql']);
        expect(properties.details).toContain('owner: sales');
        expect(xOf(properties, 'script_2.sql')[0]).toBeCloseTo(200.3, 3);
    }, 60_000);

    it('finds the most similar script by syntax', async () => {
        const hits = await SYNTAX_SEARCH.run(sql, location, basis(5), 3);
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
        expect(results.map(r => r.strategy.id)).toEqual(['description', 'syntax', 'properties']);
        expect(results[1].hits[0].scriptName).toBe('script_3.sql');
    }, 60_000);

    it('replaces existing index files', async () => {
        await writeIndexFiles(
            sql,
            location,
            { syntax: syntaxRows.slice(0, 2), description: [], properties: [] },
            { syntax: layout(2, 0), description: layout(0, 0), properties: layout(0, 0) },
            DIM,
        );
        const table = await sql.query('Count', `SELECT count(*) AS n FROM external('${location.paths.syntax}')`);
        expect(Number(table.toArray()[0].n)).toBe(2);
        const empty = await sql.query('Count', `SELECT count(*) AS n FROM external('${location.paths.properties}')`);
        expect(Number(empty.toArray()[0].n)).toBe(0);
    }, 120_000);
});
