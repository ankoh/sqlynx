import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EmbeddedComputeDatabase, EmbeddedTableImportConnection } from '../platform/database/embedded_database.js';
import { setupWebHyperDB } from '../platform/hyperdb/hyperdb_provider_web.js';
import { TestLogger } from '../platform/logger/test_logger.js';
import { AtlasSql } from './atlas_sql.js';
import type { ScriptFeatures } from './index/analysis/features.js';
import { ATLAS_COMMENTS_FILE, ATLAS_FEATURES_FILE } from './index/files.js';
import type { CommentRow, FeatureRow } from './index/rows.js';
import { LAYOUT_DIMS } from './index/tables.js';
import { COMMENT_SEARCH, FEATURE_SEARCH, searchAll } from './search/search.js';
import {
    externalDirectoryDatabase,
    indexFilesReadable,
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

function features(tables: string[]): ScriptFeatures {
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

    const featureRows: FeatureRow[] = Array.from({ length: 12 }, (_, i) => ({
        scriptName: `script_${i}.sql`,
        scriptHash: `hash_${i}`,
        truncated: false,
        embedding: basis(i),
        features: features([`table_${i}`]),
        diagnostics: [],
    }));
    const commentRows: CommentRow[] = [
        { scriptName: 'script_3.sql', scriptHash: 'hash_3', chunkIndex: 0, source: 'comment', text: 'Revenue per customer', embedding: basis(100) },
        { scriptName: 'script_3.sql', scriptHash: 'hash_3', chunkIndex: 1, source: 'comment', text: 'Orders per region', embedding: basis(101) },
        { scriptName: 'script_7.sql', scriptHash: 'hash_7', chunkIndex: 0, source: 'dashql_description', text: 'Top suppliers', embedding: basis(102) },
    ];

    it('reports missing index files as unreadable', async () => {
        expect(await indexFilesReadable(sql, location)).toBe(false);
    }, 60_000);

    it('writes Parquet files into the folder and reads them back', async () => {
        // Every file has its own layout
        const featureCoords = new Float32Array(featureRows.length * LAYOUT_DIMS).map((_, i) => i / 10);
        const commentCoords = new Float32Array(commentRows.length * LAYOUT_DIMS).map((_, i) => 100 + i / 10);
        await writeIndexFiles(sql, location, commentRows, featureRows, featureCoords, commentCoords, DIM);

        // The files are real files of the selected folder, not only visible to Hyper
        expect((await (await directory.getFileHandle(ATLAS_FEATURES_FILE)).getFile()).size).toBeGreaterThan(0);
        expect((await (await directory.getFileHandle(ATLAS_COMMENTS_FILE)).getFile()).size).toBeGreaterThan(0);
        expect(await indexFilesReadable(sql, location)).toBe(true);

        const table = await sql.query('Read back', `
            SELECT script_name, atlas_features_3d_x, tables FROM external('${location.featuresPath}') ORDER BY script_name`);
        expect(table.numRows).toBe(12);
    }, 120_000);

    it('loads a point for every feature row and for every comment chunk', async () => {
        const xOf = (points: IndexPoints, script: string) =>
            Array.from(points.owners, (owner, i) => points.scripts[owner] === script ? points.coords[i * LAYOUT_DIMS] : null)
                .filter((x): x is number => x != null)
                .sort((a, b) => a - b);

        const features = await loadIndexPoints(sql, location, 'features');
        expect(features.scripts).toHaveLength(12);
        expect(features.owners).toHaveLength(12);
        expect(features.coords).toHaveLength(12 * LAYOUT_DIMS);
        // Rows were written with the values i / 10, feature row 7 starts at 21
        expect(xOf(features, 'script_7.sql')).toHaveLength(1);
        expect(xOf(features, 'script_7.sql')[0]).toBeCloseTo(2.1, 4);

        const comments = await loadIndexPoints(sql, location, 'comments');
        expect(comments.scripts.sort()).toEqual(['script_3.sql', 'script_7.sql']);
        expect(comments.owners).toHaveLength(3);
        expect(xOf(comments, 'script_3.sql')).toHaveLength(2);
        // Comment row 2 starts at 6 in the layout of the comments
        expect(xOf(comments, 'script_7.sql')[0]).toBeCloseTo(100.6, 3);
    }, 60_000);

    it('finds the most similar script by features', async () => {
        const hits = await FEATURE_SEARCH.run(sql, location, basis(5), 3);
        expect(hits).toHaveLength(3);
        expect(hits[0].scriptName).toBe('script_5.sql');
        expect(hits[0].score).toBeCloseTo(1, 4);
        expect(hits[0].snippet).toContain('table_5');
        expect(hits[1].score).toBeLessThan(0.5);
    }, 60_000);

    it('finds the best comment chunk of a script by comments', async () => {
        const hits = await COMMENT_SEARCH.run(sql, location, basis(101, 102), 5);
        expect(hits.map(h => h.scriptName).sort()).toEqual(['script_3.sql', 'script_7.sql']);
        const byName = new Map(hits.map(h => [h.scriptName, h]));
        // script_3 has two chunks, the better one of them is reported
        expect(byName.get('script_3.sql')!.snippet).toBe('Orders per region');
        expect(byName.get('script_3.sql')!.score).toBeCloseTo(Math.SQRT1_2, 4);
        expect(byName.get('script_7.sql')!.snippet).toBe('Top suppliers');
    }, 60_000);

    it('runs all strategies for one query', async () => {
        const results = await searchAll(sql, location, basis(3));
        expect(results.map(r => r.strategy.id)).toEqual(['comments', 'features']);
        expect(results[1].hits[0].scriptName).toBe('script_3.sql');
    }, 60_000);

    it('replaces existing index files', async () => {
        await writeIndexFiles(sql, location, [], featureRows.slice(0, 2), new Float32Array(2 * LAYOUT_DIMS), new Float32Array(0), DIM);
        const table = await sql.query('Count', `SELECT count(*) AS n FROM external('${location.featuresPath}')`);
        expect(Number(table.toArray()[0].n)).toBe(2);
    }, 120_000);
});
