import { describe, expect, it } from 'vitest';

import { computeLayout, groupDuplicates, normalize } from './layout.js';

function vectors(rows: number[][]): Float32Array {
    return Float32Array.from(rows.flat());
}

describe('layout', () => {
    it('groups identical embeddings and keeps the first row as representative', () => {
        const data = vectors([[1, 0], [0, 1], [1, 0], [0.00001, 1]]);
        const { groupOf, representatives } = groupDuplicates(data, 4, 2);
        expect(Array.from(groupOf)).toEqual([0, 1, 0, 1]);
        expect(representatives).toEqual([0, 1]);
    });

    it('centers the cloud and scales the 98th percentile radius to 1', () => {
        const layout = vectors([[10, 10, 10], [12, 10, 10], [8, 10, 10], [10, 12, 10], [10, 8, 10]]);
        const { normalized, scale } = normalize(layout, 5);
        expect(scale).toBeGreaterThan(0);
        const mean = [0, 1, 2].map(d => [0, 1, 2, 3, 4].reduce((s, i) => s + normalized[i * 3 + d], 0) / 5);
        for (const m of mean) expect(Math.abs(m)).toBeLessThan(1e-6);
        const radii = [0, 1, 2, 3, 4].map(i => Math.hypot(normalized[i * 3], normalized[i * 3 + 1], normalized[i * 3 + 2]));
        expect(Math.max(...radii)).toBeCloseTo(1, 5);
    });

    it('places few distinct vectors with PCA, and duplicates next to their twin', async () => {
        const dim = 8;
        const rows = Array.from({ length: 5 }, (_, i) => Array.from({ length: dim }, (_, d) => (d === i ? 1 : 0)));
        rows.push([...rows[0]]);
        const result = await computeLayout(vectors(rows), rows.length, dim);
        expect(result.mode).toBe('trivial');
        expect(result.uniqueVectors).toBe(5);
        expect(result.coords).toHaveLength(rows.length * 3);
        expect(result.coords.every(Number.isFinite)).toBe(true);
        // The duplicate is not exactly on top of its twin, but close
        const distance = Math.hypot(
            result.coords[0] - result.coords[15],
            result.coords[1] - result.coords[16],
            result.coords[2] - result.coords[17],
        );
        expect(distance).toBeGreaterThan(0);
        expect(distance).toBeLessThan(0.05);
    });

    it('lays out many vectors in 3D with UMAP', async () => {
        const dim = 16;
        const count = 40;
        // Two well separated clusters
        const rows = Array.from({ length: count }, (_, i) =>
            Array.from({ length: dim }, (_, d) => (d === (i < 20 ? 0 : 8) ? 1 : 0) + ((i * 7 + d * 13) % 10) / 100));
        const result = await computeLayout(vectors(rows), count, dim);
        expect(result.mode).toBe('cold');
        expect(result.coords).toHaveLength(count * 3);
        expect(result.coords.every(Number.isFinite)).toBe(true);
        const centroid = (from: number, to: number) => [0, 1, 2].map(d => {
            let s = 0;
            for (let i = from; i < to; ++i) s += result.coords[i * 3 + d];
            return s / (to - from);
        });
        const a = centroid(0, 20);
        const b = centroid(20, 40);
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.5);
    }, 60_000);
});
