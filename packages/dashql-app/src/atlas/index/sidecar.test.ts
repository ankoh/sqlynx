import { describe, expect, it } from 'vitest';

import { ATLAS_EMBEDDER_CONFIG } from './model.js';
import { ATLAS_FORMAT_VERSION, isIndexCurrent, parseSidecar, readSidecar, writeSidecar, type AtlasSidecar } from './sidecar.js';

const sidecar = (overrides: Partial<AtlasSidecar> = {}): AtlasSidecar => ({
    formatVersion: ATLAS_FORMAT_VERSION,
    embedder: ATLAS_EMBEDDER_CONFIG,
    layout: 'umap-3d',
    layoutScales: { features: 1, comments: 1 },
    scripts: { 'a.sql': 'h1', 'b/c.sql': 'h2' },
    createdAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
});

const scripts = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('atlas sidecar', () => {
    it('accepts an index of the same scripts and embedder', () => {
        expect(isIndexCurrent(sidecar(), ATLAS_EMBEDDER_CONFIG, scripts({ 'a.sql': 'h1', 'b/c.sql': 'h2' }))).toBe(true);
    });

    it('rejects a missing sidecar', () => {
        expect(isIndexCurrent(undefined, ATLAS_EMBEDDER_CONFIG, scripts({}))).toBe(false);
    });

    it('rejects changed, added and removed scripts', () => {
        expect(isIndexCurrent(sidecar(), ATLAS_EMBEDDER_CONFIG, scripts({ 'a.sql': 'changed', 'b/c.sql': 'h2' }))).toBe(false);
        expect(isIndexCurrent(sidecar(), ATLAS_EMBEDDER_CONFIG, scripts({ 'a.sql': 'h1', 'b/c.sql': 'h2', 'new.sql': 'h3' }))).toBe(false);
        expect(isIndexCurrent(sidecar(), ATLAS_EMBEDDER_CONFIG, scripts({ 'a.sql': 'h1' }))).toBe(false);
    });

    it('rejects an index of another embedder', () => {
        const other = sidecar({ embedder: { ...ATLAS_EMBEDDER_CONFIG, dtype: 'q8' } });
        expect(isIndexCurrent(other, ATLAS_EMBEDDER_CONFIG, scripts({ 'a.sql': 'h1', 'b/c.sql': 'h2' }))).toBe(false);
        const model = sidecar({ embedder: { ...ATLAS_EMBEDDER_CONFIG, model: 'Snowflake/snowflake-arctic-embed-s' } });
        expect(isIndexCurrent(model, ATLAS_EMBEDDER_CONFIG, scripts({ 'a.sql': 'h1', 'b/c.sql': 'h2' }))).toBe(false);
    });

    it('ignores sidecars it cannot understand', () => {
        expect(parseSidecar(null)).toBeUndefined();
        expect(parseSidecar({ formatVersion: 999 })).toBeUndefined();
        expect(parseSidecar({ formatVersion: ATLAS_FORMAT_VERSION })).toBeUndefined();
    });

    it('round-trips through a folder', async () => {
        const root = await navigator.storage.getDirectory();
        const name = `dashql-atlas-sidecar-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        try {
            expect(await readSidecar(directory)).toBeUndefined();
            await writeSidecar(directory, sidecar());
            expect(await readSidecar(directory)).toEqual(sidecar());
            await writeSidecar(directory, sidecar({ layoutScales: { features: 2.5, comments: 4 } }));
            expect((await readSidecar(directory))?.layoutScales).toEqual({ features: 2.5, comments: 4 });
        } finally {
            await root.removeEntry(name, { recursive: true });
        }
    });
});
