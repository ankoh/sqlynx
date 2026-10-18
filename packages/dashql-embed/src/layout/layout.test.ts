import { describe, expect, it } from 'vitest';
import { computeLayout, layoutKey, type LayoutDims, type PreviousLayout } from './layout.js';
import { pcaScores } from './pca.js';

const DIM = 48;
const CLUSTERS = 8;

function prng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussian(next: () => number) {
    return Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
}

/// Unit vectors around a few random centers, the shape of embeddings of related scripts
function clusteredVectors(perCluster: number, noiseSeed = 1) {
    const centerRandom = prng(1000);
    const centers = Array.from({ length: CLUSTERS }, () => Array.from({ length: DIM }, () => gaussian(centerRandom)));
    const next = prng(noiseSeed);
    const vectors: Float32Array[] = [];
    const cluster: number[] = [];
    for (let c = 0; c < CLUSTERS; ++c) {
        for (let i = 0; i < perCluster; ++i) {
            const v = new Float32Array(DIM);
            let norm = 0;
            for (let d = 0; d < DIM; ++d) {
                v[d] = centers[c][d] + 0.6 * gaussian(next);
                norm += v[d] * v[d];
            }
            norm = Math.sqrt(norm);
            for (let d = 0; d < DIM; ++d) v[d] /= norm;
            vectors.push(v);
            cluster.push(c);
        }
    }
    return { vectors, cluster };
}

function flatten(vectors: Float32Array[]): Float32Array {
    const flat = new Float32Array(vectors.length * DIM);
    vectors.forEach((v, i) => flat.set(v, i * DIM));
    return flat;
}

const keysOf = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => layoutKey(`s${i + offset}.sql`, `h${i + offset}`));

const axesOf = (dims: LayoutDims) => Array.from({ length: dims }, (_, d) => d);

function distance(coords: Float32Array, dims: LayoutDims, a: number, b: number): number {
    let s = 0;
    for (const d of axesOf(dims)) s += (coords[a * dims + d] - coords[b * dims + d]) ** 2;
    return Math.sqrt(s);
}

function previousOf(keys: string[], coords: Float32Array, dims: LayoutDims, scale: number): PreviousLayout {
    return {
        coords: new Map(keys.map((key, i) => [key, Array.from(coords.subarray(i * dims, (i + 1) * dims))])),
        scale,
    };
}

/// Mean ratio of the distance to the own cluster's points over the distance to all other points
function separation(coords: Float32Array, dims: LayoutDims, cluster: number[]): number {
    let within = 0, withinCount = 0, between = 0, betweenCount = 0;
    for (let i = 0; i < cluster.length; i += 3) {
        for (let j = 0; j < cluster.length; j += 3) {
            if (i === j) continue;
            if (cluster[i] === cluster[j]) { within += distance(coords, dims, i, j); withinCount++; }
            else { between += distance(coords, dims, i, j); betweenCount++; }
        }
    }
    return within / withinCount / (between / betweenCount);
}

describe('pcaScores', () => {
    it('finds the dominant axis, deterministically', () => {
        const n = 200;
        const next = prng(3);
        const data = new Float32Array(n * 4);
        for (let i = 0; i < n; ++i) {
            data[i * 4] = 5 * gaussian(next);
            data[i * 4 + 1] = 1 * gaussian(next);
            data[i * 4 + 2] = 0.1 * gaussian(next);
            data[i * 4 + 3] = 0.1 * gaussian(next);
        }
        const a = pcaScores(data, n, 4, 2);
        expect(Array.from(pcaScores(data, n, 4, 2))).toEqual(Array.from(a));
        let corr0 = 0, corr1 = 0, v0 = 0, v1 = 0;
        for (let i = 0; i < n; ++i) {
            corr0 += a[i * 2] * data[i * 4]; v0 += a[i * 2] ** 2;
            corr1 += a[i * 2 + 1] * data[i * 4 + 1]; v1 += a[i * 2 + 1] ** 2;
        }
        expect(Math.abs(corr0 / v0)).toBeGreaterThan(0.9);
        expect(Math.abs(corr1 / v1)).toBeGreaterThan(0.8);
        expect(v0).toBeGreaterThan(v1);
    });

    it('does not fail on constant data', () => {
        const scores = pcaScores(new Float32Array(20).fill(0.5), 5, 4, 2);
        expect(scores.every(v => v === 0)).toBe(true);
    });
});

describe.each([3, 2] as const)('computeLayout in %iD', dims => {
    const axes = axesOf(dims);

        it('lays out clustered vectors and scatters duplicates around their twin', async () => {
            const { vectors, cluster } = clusteredVectors(60);
            const withTwins = [...vectors, ...vectors.slice(0, 40).map(v => new Float32Array(v))];
            const result = await computeLayout(flatten(withTwins), keysOf(withTwins.length), DIM, { dims });
            expect(result.mode).toBe('cold');
            expect(result.uniqueVectors).toBe(vectors.length);
            expect(result.coords.length).toBe(withTwins.length * dims);
            expect(result.coords.every(Number.isFinite)).toBe(true);
            for (let i = 0; i < 40; ++i) {
                const d = distance(result.coords, dims, i, vectors.length + i);
                expect(d).toBeGreaterThan(0);
                expect(d).toBeLessThan(0.05);
            }
            const radii = Array.from({ length: vectors.length }, (_, i) => Math.hypot(...Array.from(result.coords.subarray(i * dims, (i + 1) * dims)))).sort((a, b) => a - b);
            expect(radii[Math.floor(0.98 * radii.length)]).toBeGreaterThan(0.7);
            expect(radii[Math.floor(0.98 * radii.length)]).toBeLessThan(1.3);
            expect(separation(result.coords, dims, cluster)).toBeLessThan(0.6);
        });

        it('is deterministic', async () => {
            const { vectors } = clusteredVectors(30);
            const a = await computeLayout(flatten(vectors), keysOf(vectors.length), DIM, { dims });
            const b = await computeLayout(flatten(vectors), keysOf(vectors.length), DIM, { dims });
            expect(Array.from(b.coords)).toEqual(Array.from(a.coords));
        });

        it('falls back to PCA for a handful of distinct vectors', async () => {
            const { vectors } = clusteredVectors(1);
            const twice = [...vectors, ...vectors];
            const result = await computeLayout(flatten(twice), keysOf(twice.length), DIM, { dims });
            expect(result.mode).toBe('trivial');
            expect(result.coords.every(Number.isFinite)).toBe(true);
            const single = await computeLayout(flatten(vectors.slice(0, 1)), keysOf(1), DIM, { dims });
            expect(Array.from(single.coords)).toEqual(axes.map(() => 0));
        });

        it('keeps the layout when scripts are only removed', async () => {
            const { vectors } = clusteredVectors(80);
            const keys = keysOf(vectors.length);
            const first = await computeLayout(flatten(vectors), keys, DIM, { dims });
            const previous = previousOf(keys, first.coords, dims, first.scale);

            const same = await computeLayout(flatten(vectors), keys, DIM, { dims, previous });
            expect(same.mode).toBe('warm');
            let maxMove = 0;
            for (let i = 0; i < first.coords.length; ++i) maxMove = Math.max(maxMove, Math.abs(same.coords[i] - first.coords[i]));
            expect(maxMove).toBeLessThan(1e-4);

            const kept = vectors.map((_, i) => i).filter(i => i % 4 !== 0);
            const fewer = await computeLayout(flatten(kept.map(i => vectors[i])), kept.map(i => keys[i]), DIM, { dims, previous });
            // Removing scripts re-centers the cloud, which shifts everything by the same small amount: the shape is unchanged
            kept.forEach((old, i) => {
                for (const d of axes) expect(Math.abs(fewer.coords[i * dims + d] - first.coords[old * dims + d])).toBeLessThan(1e-2);
                const j = (i * 7 + 3) % kept.length;
                expect(distance(fewer.coords, dims, i, j)).toBeCloseTo(distance(first.coords, dims, old, kept[j]), 4);
            });
        });

        it('treats malformed previous coordinates as unknown scripts', async () => {
            const { vectors } = clusteredVectors(40);
            const keys = keysOf(vectors.length);
            const first = await computeLayout(flatten(vectors), keys, DIM, { dims });
            const previous = previousOf(keys, first.coords, dims, first.scale);
            previous.coords.set(keys[0], [Number.NaN, ...axes.slice(1)]);
            previous.coords.set(keys[1], [0]);
            const result = await computeLayout(flatten(vectors), keys, DIM, { dims, previous });
            expect(result.mode).toBe('warm');
            expect(result.coords.every(Number.isFinite)).toBe(true);
        });

        it('starts from scratch when the previous layout covers too few scripts', async () => {
            const { vectors } = clusteredVectors(40);
            const keys = keysOf(vectors.length);
            const first = await computeLayout(flatten(vectors), keys, DIM, { dims });
            const previous = previousOf(keys.slice(0, 20), first.coords.subarray(0, 20 * dims), dims, first.scale);
            const result = await computeLayout(flatten(vectors), keys, DIM, { dims, previous });
            expect(result.mode).toBe('cold');
        });

        it('barely moves known scripts when scripts are removed and added', async () => {
            const { vectors, cluster } = clusteredVectors(80);
            const keys = keysOf(vectors.length);
            const first = await computeLayout(flatten(vectors), keys, DIM, { dims });
            const previous = previousOf(keys, first.coords, dims, first.scale);

            // Drop every 10th script, add scripts from the same clusters under new names
            const kept = vectors.map((_, i) => i).filter(i => i % 10 !== 0);
            const added = clusteredVectors(8, 99);
            const next = [...kept.map(i => vectors[i]), ...added.vectors];
            const nextKeys = [...kept.map(i => keys[i]), ...keysOf(added.vectors.length, 10000)];
            const warm = await computeLayout(flatten(next), nextKeys, DIM, { dims, previous });
            expect(warm.mode).toBe('warm');
            expect(warm.scale).toBe(first.scale);

            // Known scripts stay close to where they were (a fraction of the cloud radius, which is 1)
            let moved = 0;
            kept.forEach((old, i) => {
                moved += Math.hypot(...axes.map(d => warm.coords[i * dims + d] - first.coords[old * dims + d]));
            });
            expect(moved / kept.length).toBeLessThan(0.2);

            // New scripts end up closest to the centroid of their own cluster
            const centroid = (c: number) => {
                const sum = axes.map(() => 0);
                let count = 0;
                kept.forEach((old, i) => {
                    if (cluster[old] !== c) return;
                    for (const d of axes) sum[d] += warm.coords[i * dims + d];
                    count++;
                });
                return sum.map(v => v / count);
            };
            const centroids = Array.from({ length: CLUSTERS }, (_, c) => centroid(c));
            let correct = 0;
            added.vectors.forEach((_, j) => {
                const at = kept.length + j;
                const dist = centroids.map(c => Math.hypot(...axes.map(d => warm.coords[at * dims + d] - c[d])));
                if (dist.indexOf(Math.min(...dist)) === added.cluster[j]) correct++;
            });
            expect(correct / added.vectors.length).toBeGreaterThan(0.9);
        });
});
