/// Scores of the first `k` principal components of `data` (n rows of `dim` values), n * k row-major.
/// Power iteration with deflation. Deterministic: fixed start vectors and a fixed sign (the score with the largest
/// magnitude is positive), so the same data always gives the same coordinates.
export function pcaScores(data: Float32Array, n: number, dim: number, k: number): Float32Array {
    const mean = new Float64Array(dim);
    for (let i = 0; i < n; ++i) for (let d = 0; d < dim; ++d) mean[d] += data[i * dim + d];
    for (let d = 0; d < dim; ++d) mean[d] /= Math.max(n, 1);
    const centered = new Float64Array(n * dim);
    for (let i = 0; i < n; ++i) for (let d = 0; d < dim; ++d) centered[i * dim + d] = data[i * dim + d] - mean[d];

    const components: Float64Array[] = [];
    const scores = new Float32Array(n * k);
    const projected = new Float64Array(n);
    for (let c = 0; c < k; ++c) {
        let v = new Float64Array(dim);
        let state = 0x9e3779b9 + c;
        for (let d = 0; d < dim; ++d) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            v[d] = state / 4294967296 - 0.5;
        }
        normalize(deflate(v, components));
        for (let iter = 0; iter < 300; ++iter) {
            projected.fill(0);
            for (let i = 0; i < n; ++i) {
                let s = 0;
                for (let d = 0; d < dim; ++d) s += centered[i * dim + d] * v[d];
                projected[i] = s;
            }
            const next = new Float64Array(dim);
            for (let i = 0; i < n; ++i) {
                const s = projected[i];
                for (let d = 0; d < dim; ++d) next[d] += centered[i * dim + d] * s;
            }
            deflate(next, components);
            if (normalize(next) === 0) break;
            let dot = 0;
            for (let d = 0; d < dim; ++d) dot += next[d] * v[d];
            v = next;
            if (1 - Math.abs(dot) < 1e-10) break;
        }
        components.push(v);
        let sign = 1;
        let best = 0;
        for (let i = 0; i < n; ++i) {
            let s = 0;
            for (let d = 0; d < dim; ++d) s += centered[i * dim + d] * v[d];
            projected[i] = s;
            if (Math.abs(s) > best) {
                best = Math.abs(s);
                sign = s < 0 ? -1 : 1;
            }
        }
        for (let i = 0; i < n; ++i) scores[i * k + c] = sign * projected[i];
    }
    return scores;
}

function deflate(v: Float64Array, components: Float64Array[]): Float64Array {
    for (const u of components) {
        let dot = 0;
        for (let d = 0; d < v.length; ++d) dot += v[d] * u[d];
        for (let d = 0; d < v.length; ++d) v[d] -= dot * u[d];
    }
    return v;
}

function normalize(v: Float64Array): number {
    let norm = 0;
    for (let d = 0; d < v.length; ++d) norm += v[d] * v[d];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let d = 0; d < v.length; ++d) v[d] /= norm;
    return norm;
}
