import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HashEmbedder } from '../embedding/embedder.js';
import { analyzeScripts, embedScripts } from '../indexer.js';
import { sha256 } from '../inputs.js';
import { commentsTable, embeddingsOf, featuresTable, indexMetadata, readParquetFile, writeParquetFile } from './parquet.js';
import { tpchAnalyzer } from '../test_fixture.js';

const dirs: string[] = [];
afterAll(async () => {
    await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
});

describe('parquet output', () => {
    it('round-trips both files with embeddings and metadata', async () => {
        const embedder = new HashEmbedder(32);
        const text = '-- Customers per segment\nselect c_mktsegment, count(*) from customer group by 1;';
        const file = { id: 'a.sql', path: '/x/a.sql', text, hash: sha256(text) };
        const plain = { id: 'b.sql', path: '/x/b.sql', text: 'select 1', hash: sha256('select 1') };
        const scripts = analyzeScripts([file, plain], await tpchAnalyzer(), embedder);
        const { comments, features } = await embedScripts(scripts, embedder);
        expect(features.map(f => f.scriptName)).toEqual(['a.sql', 'b.sql']);
        expect(comments.map(c => c.scriptName)).toEqual(['a.sql']);

        const dir = await mkdtemp(join(tmpdir(), 'dashql-embed-'));
        dirs.push(dir);
        const meta = (kind: 'comments' | 'features') => indexMetadata(kind, embedder.config, 32, 'test');
        await writeParquetFile(join(dir, 'features.parquet'), featuresTable(features, 32, meta('features')));
        await writeParquetFile(join(dir, 'comments.parquet'), commentsTable(comments, 32, meta('comments')));

        const f = await readParquetFile(join(dir, 'features.parquet'));
        expect(f.dim).toBe(32);
        expect(f.metadata.get('dashql_embed.model')).toBe('hash-32');
        expect(f.table.numRows).toBe(2);
        expect(f.table.schema.fields.find(x => x.name === 'embedding')!.type.toString()).toBe('FixedSizeList[32]<Float32>');
        expect(Array.from(f.table.getChild('tables')!.get(0))).toEqual(['customer']);
        const vectors = embeddingsOf(f);
        expect(Array.from(vectors.subarray(0, 32))).toEqual(Array.from(features[0].embedding));
        expect(Array.from(vectors.subarray(32, 64))).toEqual(Array.from(features[1].embedding));

        const c = await readParquetFile(join(dir, 'comments.parquet'));
        expect(c.table.getChild('text')!.get(0)).toBe('Customers per segment');
        expect(c.table.getChild('source')!.get(0)).toBe('comment');
        expect(c.table.getChild('script_name')!.get(0)).toBe('a.sql');
        expect(f.table.getChild('script_name')!.toArray()).toEqual(['a.sql', 'b.sql']);
    });

    it('writes empty tables', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'dashql-embed-'));
        dirs.push(dir);
        const meta = indexMetadata('comments', new HashEmbedder(8).config, 8, 'test');
        await writeParquetFile(join(dir, 'comments.parquet'), commentsTable([], 8, meta));
        expect((await readParquetFile(join(dir, 'comments.parquet'))).table.numRows).toBe(0);
    });
});
