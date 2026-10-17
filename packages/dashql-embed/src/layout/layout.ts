import { createHash } from 'node:crypto';
import { pcaScores } from './pca.js';
import { loadUmap, type UmapOptions } from './umap_module.js';

export const LAYOUT_DIMS = 2;

/// Coordinates of an earlier index run, in the normalized space that `computeLayout` returns
export interface PreviousLayout {
    /// `layoutKey` -> x, y, z
    coords: Map<string, number[]>;
    /// Factor from the normalized coordinates back to the units UMAP worked in
    scale: number;
}

export interface LayoutOptions {
    previous?: PreviousLayout;
    seed?: number;
    log?: (message: string) => void;
}

export interface LayoutResult {
    /// n * LAYOUT_DIMS (x, y), centered at the origin. The cloud's 98th percentile radius is 1.
    coords: Float32Array;
    scale: number;
    /// cold: fresh from PCA, warm: continued from `previous`, trivial: too few distinct vectors for UMAP
    mode: 'cold' | 'warm' | 'trivial';
    uniqueVectors: number;
}

/// UMAP works on neighbor graphs, so a handful of vectors have nothing to lay out
const MIN_UNIQUE_FOR_UMAP = 10;
/// A warm start needs enough anchored points to keep the layout recognizable
const MIN_ANCHORED_FRACTION = 0.5;
/// The UMAP defaults. On real script embeddings they keep more of the neighbors in 2D than 30 neighbors with a minimum
/// distance of 0.3 (neighbor recall 0.54 against 0.50).
const N_NEIGHBORS = 15;
const MIN_DIST = 0.1;
const COLD_INIT_EXTENT = 10;
/// Measured on real script embeddings: this matches the quality of a fresh layout while known scripts move a quarter
/// as far as with 150 epochs at 0.25, which gains nothing and moves them by almost half the cloud radius.
const WARM_EPOCHS = 60;
const WARM_LEARNING_RATE = 0.1;
const DUPLICATE_JITTER = 0.01;
const NEW_POINT_JITTER = 0.05;
const NEW_POINT_NEIGHBORS = 5;

export function layoutKey(scriptName: string, scriptHash: string): string {
    return `${scriptName}\u0000${scriptHash}`;
}

/// Place embeddings in 2D with UMAP so that a viewer can show them as a scatter plot.
///
/// Embeddings of scripts with identical features are exactly equal. UMAP puts them in one spot and then becomes
/// unstable for the rest, so only distinct vectors are laid out and duplicates are scattered around their twin.
/// The layout starts from PCA, or from `previous` when most scripts were indexed before, so that re-indexing a changed
/// script set moves the cloud a little instead of reshuffling it.
export async function computeLayout(
    embeddings: Float32Array,
    keys: string[],
    dim: number,
    options: LayoutOptions = {},
): Promise<LayoutResult> {
    const n = keys.length;
    if (embeddings.length !== n * dim) throw new Error(`expected ${n * dim} embedding values, got ${embeddings.length}`);
    const { groupOf, representatives } = groupDuplicates(embeddings, n, dim);
    const unique = representatives.length;
    const vectors = new Float32Array(unique * dim);
    representatives.forEach((row, u) => vectors.set(embeddings.subarray(row * dim, (row + 1) * dim), u * dim));

    let layout: Float32Array;
    let mode: LayoutResult['mode'];
    let umapScale = COLD_INIT_EXTENT;
    if (unique < MIN_UNIQUE_FOR_UMAP) {
        layout = pcaScores(vectors, unique, dim, LAYOUT_DIMS);
        mode = 'trivial';
    } else {
        const start = anchorsFromPrevious(vectors, unique, dim, groupOf, keys, options.previous);
        const anchors = start?.coords;
        const umapOptions: UmapOptions = {
            metric: 'cosine',
            nNeighbors: Math.min(N_NEIGHBORS, unique - 1),
            minDist: MIN_DIST,
            seed: options.seed ?? 42,
        };
        if (anchors) {
            mode = 'warm';
            umapScale = options.previous!.scale;
            umapOptions.initialEmbedding = anchors;
            umapOptions.nEpochs = WARM_EPOCHS;
            umapOptions.learningRate = WARM_LEARNING_RATE;
        } else {
            mode = 'cold';
            umapOptions.initialEmbedding = scaleToExtent(pcaScores(vectors, unique, dim, LAYOUT_DIMS), COLD_INIT_EXTENT);
        }
        if (start && start.added === 0) {
            // Only scripts were removed or kept, nothing could improve and optimizing would only move them
            options.log?.(`keeping the layout of ${unique} distinct vectors`);
            layout = start.coords;
        } else {
            options.log?.(`laying out ${unique} distinct vectors in ${LAYOUT_DIMS}D (${mode} start)`);
            const umap = await loadUmap();
            const instance = await umap.createUMAP(unique, dim, LAYOUT_DIMS, vectors, umapOptions);
            try {
                await instance.run();
                layout = new Float32Array(instance.embedding);
            } finally {
                instance.destroy();
            }
        }
    }

    const { normalized, scale } = normalize(layout, unique, mode === 'warm' ? umapScale : undefined);
    const coords = new Float32Array(n * LAYOUT_DIMS);
    const seen = new Set<number>();
    for (let i = 0; i < n; ++i) {
        const u = groupOf[i];
        for (let d = 0; d < LAYOUT_DIMS; ++d) coords[i * LAYOUT_DIMS + d] = normalized[u * LAYOUT_DIMS + d];
        if (seen.has(u)) addJitter(coords, i, DUPLICATE_JITTER);
        seen.add(u);
    }
    return { coords, scale, mode, uniqueVectors: unique };
}

/// Group rows with the same embedding (to 4 decimals). Representatives are the first rows of each group.
function groupDuplicates(embeddings: Float32Array, n: number, dim: number) {
    const groupOf = new Int32Array(n);
    const representatives: number[] = [];
    const groups = new Map<string, number>();
    const quantized = new Int16Array(dim);
    for (let i = 0; i < n; ++i) {
        for (let d = 0; d < dim; ++d) {
            quantized[d] = Math.max(-32768, Math.min(32767, Math.round(embeddings[i * dim + d] * 1e4)));
        }
        const key = createHash('sha1').update(new Uint8Array(quantized.buffer)).digest('hex');
        let group = groups.get(key);
        if (group === undefined) {
            group = representatives.length;
            groups.set(key, group);
            representatives.push(i);
        }
        groupOf[i] = group;
    }
    return { groupOf, representatives };
}

/// Starting coordinates in UMAP units from an earlier layout: scripts that were indexed before keep their place and new
/// ones start at the mean of their nearest anchored neighbors. Undefined when too few scripts were indexed before.
function anchorsFromPrevious(
    vectors: Float32Array,
    unique: number,
    dim: number,
    groupOf: Int32Array,
    keys: string[],
    previous: PreviousLayout | undefined,
): { coords: Float32Array; added: number } | undefined {
    if (!previous) return undefined;
    const placed = new Float32Array(unique * LAYOUT_DIMS);
    const anchored = new Uint8Array(unique);
    for (let i = 0; i < keys.length; ++i) {
        const u = groupOf[i];
        const at = anchored[u] ? undefined : previous.coords.get(keys[i]);
        // A malformed entry is treated like an unknown script
        if (at && at.length === LAYOUT_DIMS && at.every(Number.isFinite)) {
            anchored[u] = 1;
            for (let d = 0; d < LAYOUT_DIMS; ++d) placed[u * LAYOUT_DIMS + d] = at[d] * previous.scale;
        }
    }
    const anchoredRows: number[] = [];
    for (let u = 0; u < unique; ++u) if (anchored[u]) anchoredRows.push(u);
    if (anchoredRows.length < MIN_ANCHORED_FRACTION * unique) return undefined;

    const norms = new Float64Array(unique);
    for (let u = 0; u < unique; ++u) {
        let s = 0;
        for (let d = 0; d < dim; ++d) s += vectors[u * dim + d] ** 2;
        norms[u] = Math.sqrt(s) || 1;
    }
    let added = 0;
    for (let u = 0; u < unique; ++u) {
        if (anchored[u]) continue;
        added++;
        const best: { row: number; sim: number }[] = [];
        for (const row of anchoredRows) {
            let dot = 0;
            for (let d = 0; d < dim; ++d) dot += vectors[u * dim + d] * vectors[row * dim + d];
            const sim = dot / (norms[u] * norms[row]);
            if (best.length < NEW_POINT_NEIGHBORS || sim > best[best.length - 1].sim) {
                best.push({ row, sim });
                best.sort((a, b) => b.sim - a.sim);
                if (best.length > NEW_POINT_NEIGHBORS) best.pop();
            }
        }
        for (const { row } of best) {
            for (let d = 0; d < LAYOUT_DIMS; ++d) placed[u * LAYOUT_DIMS + d] += placed[row * LAYOUT_DIMS + d] / best.length;
        }
        addJitter(placed, u, NEW_POINT_JITTER * previous.scale);
    }
    return { coords: placed, added };
}

/// Center at the mean and scale the 98th percentile radius to 1. A warm start keeps the scale of the previous layout so
/// that the cloud does not breathe between runs.
function normalize(layout: Float32Array, n: number, keepScale: number | undefined) {
    const center = new Float64Array(LAYOUT_DIMS);
    for (let i = 0; i < n; ++i) for (let d = 0; d < LAYOUT_DIMS; ++d) center[d] += layout[i * LAYOUT_DIMS + d] / n;
    const radii = new Float64Array(n);
    for (let i = 0; i < n; ++i) {
        let s = 0;
        for (let d = 0; d < LAYOUT_DIMS; ++d) s += (layout[i * LAYOUT_DIMS + d] - center[d]) ** 2;
        radii[i] = Math.sqrt(s);
    }
    const sorted = Array.from(radii).sort((a, b) => a - b);
    const p98 = sorted[Math.min(n - 1, Math.floor(0.98 * n))];
    const scale = keepScale ?? (p98 > 0 ? p98 : 1);
    const normalized = new Float32Array(n * LAYOUT_DIMS);
    for (let i = 0; i < n; ++i) {
        for (let d = 0; d < LAYOUT_DIMS; ++d) normalized[i * LAYOUT_DIMS + d] = (layout[i * LAYOUT_DIMS + d] - center[d]) / scale;
    }
    return { normalized, scale };
}

function scaleToExtent(coords: Float32Array, extent: number): Float32Array {
    let max = 0;
    for (const v of coords) max = Math.max(max, Math.abs(v));
    const factor = max > 0 ? extent / max : 0;
    return coords.map(v => v * factor);
}

/// Offset row `row` by `radius` in a direction that only depends on the row
function addJitter(coords: Float32Array, row: number, radius: number) {
    let a = (row + 1) * 0x6d2b79f5;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const direction = new Float64Array(LAYOUT_DIMS);
    let norm = 0;
    for (let d = 0; d < LAYOUT_DIMS; ++d) {
        // Box-Muller, so that directions are uniform in any dimension
        direction[d] = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
        norm += direction[d] ** 2;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < LAYOUT_DIMS; ++d) coords[row * LAYOUT_DIMS + d] += (radius * direction[d]) / norm;
}
