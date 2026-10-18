import { embedWithUMAP } from '../../compute/umap/umap_projection.js';
import { pcaScores } from './pca.js';
import { LAYOUT_DIMS } from './tables.js';

export interface LayoutResult {
    /// n * 3 (x, y, z), centered at the origin. The cloud's 98th percentile radius is 1.
    coords: Float32Array;
    /// Factor from the normalized coordinates back to the units UMAP worked in
    scale: number;
    /// cold: fresh from PCA, trivial: too few distinct vectors for UMAP
    mode: 'cold' | 'trivial';
    uniqueVectors: number;
}

/// UMAP works on neighbor graphs, so a handful of vectors have nothing to lay out
const MIN_UNIQUE_FOR_UMAP = 10;
const N_NEIGHBORS = 15;
const MIN_DIST = 0.1;
const COLD_INIT_EXTENT = 10;
const DUPLICATE_JITTER = 0.01;

/// Place embeddings in 3D with UMAP, starting from a PCA layout.
///
/// Embeddings of scripts with identical features are exactly equal. UMAP puts them in one spot and then becomes
/// unstable for the rest, so only distinct vectors are laid out and duplicates are scattered around their twin.
export async function computeLayout(
    embeddings: Float32Array,
    count: number,
    dim: number,
    onProgress?: (progress: number, stage: string) => void,
): Promise<LayoutResult> {
    if (embeddings.length !== count * dim) throw new Error(`expected ${count * dim} embedding values, got ${embeddings.length}`);
    if (count === 0) return { coords: new Float32Array(0), scale: 1, mode: 'trivial', uniqueVectors: 0 };
    const { groupOf, representatives } = groupDuplicates(embeddings, count, dim);
    const unique = representatives.length;
    const vectors = new Float32Array(unique * dim);
    representatives.forEach((row, u) => vectors.set(embeddings.subarray(row * dim, (row + 1) * dim), u * dim));

    let layout: Float32Array;
    let mode: LayoutResult['mode'];
    if (unique < MIN_UNIQUE_FOR_UMAP) {
        layout = pcaScores(vectors, unique, dim, LAYOUT_DIMS);
        mode = 'trivial';
    } else {
        mode = 'cold';
        const run = embedWithUMAP(
            { data: vectors, count: unique, dimension: dim },
            {
                metric: 'cosine',
                nNeighbors: Math.min(N_NEIGHBORS, unique - 1),
                minDist: MIN_DIST,
                seed: 42,
                initialEmbedding: scaleToExtent(pcaScores(vectors, unique, dim, LAYOUT_DIMS), COLD_INIT_EXTENT),
            },
            LAYOUT_DIMS,
            onProgress,
        );
        layout = await run.promise;
    }

    const { normalized, scale } = normalize(layout, unique);
    const coords = new Float32Array(count * LAYOUT_DIMS);
    const seen = new Set<number>();
    for (let i = 0; i < count; ++i) {
        const u = groupOf[i];
        for (let d = 0; d < LAYOUT_DIMS; ++d) coords[i * LAYOUT_DIMS + d] = normalized[u * LAYOUT_DIMS + d];
        if (seen.has(u)) addJitter(coords, i, DUPLICATE_JITTER);
        seen.add(u);
    }
    return { coords, scale, mode, uniqueVectors: unique };
}

/// FNV-1a over the vector quantized to 4 decimals. Collisions are not a concern at the scale of a folder of scripts,
/// and a collision would only place two scripts on top of each other.
function hashQuantized(quantized: Int16Array): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < quantized.length; ++i) {
        const v = quantized[i] & 0xffff;
        h1 = Math.imul(h1 ^ v, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + v + i, 0x85ebca6b) >>> 0;
    }
    return `${h1.toString(16)}:${h2.toString(16)}`;
}

/// Group rows with the same embedding (to 4 decimals). Representatives are the first rows of each group.
export function groupDuplicates(embeddings: Float32Array, n: number, dim: number) {
    const groupOf = new Int32Array(n);
    const representatives: number[] = [];
    const groups = new Map<string, number>();
    const quantized = new Int16Array(dim);
    for (let i = 0; i < n; ++i) {
        for (let d = 0; d < dim; ++d) {
            quantized[d] = Math.max(-32768, Math.min(32767, Math.round(embeddings[i * dim + d] * 1e4)));
        }
        const key = hashQuantized(quantized);
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

/// Center at the mean and scale the 98th percentile radius to 1
export function normalize(layout: Float32Array, n: number) {
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
    const scale = p98 > 0 ? p98 : 1;
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
