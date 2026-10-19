import type { UMAPOptions } from '@dashql/umap-wasm';

import type { EmbeddingMatrix } from './umap_extraction.js';
import {
    UMAPWorkerRequestType,
    UMAPWorkerResponse,
    UMAPWorkerResponseType,
} from './umap_worker_request.js';

/// A projection request built from a resolved `'umap'` visualize spec: the vector
/// column to project plus the UMAP options. The view/notebook layer derives this
/// from a `UmapSpec`; the compute module only consumes the plain request.
export interface UmapRequest {
    /// The column holding the embedding vectors (FixedSizeList/List of Float32).
    vectorColumn: string;
    /// Options forwarded to createUMAP (nNeighbors, minDist, metric, ...).
    options: UMAPOptions;
}

/// The 2D result of projecting an embedding matrix, split into the `x`/`y`
/// Float32Arrays the scatter renderer consumes.
export interface Projection2D {
    x: Float32Array;
    y: Float32Array;
}

/// A running projection: a promise for the 2D result plus a `cancel()` that
/// abandons the worker run (on card unmount / re-run) so a stale result never
/// lands and the wasm UMAP instance is freed.
export interface RunningProjection {
    readonly promise: Promise<Projection2D>;
    cancel(): void;
}

/// Progress callback: `stage` is the UMAP phase ("knn", "optimize", ...), `progress`
/// is in [0, 1]. Wired to the notebook status/log surface.
export type ProjectionProgress = (progress: number, stage: string) => void;

let nextRunId = 1;

/// Spawn (or reuse) the UMAP worker and project `matrix` to 2D. Each call gets a
/// fresh messageId; the returned handle streams progress and can be cancelled.
///
/// Split the N×2 row-major worker output into the separate `x`/`y` arrays the
/// EmbeddingScatter consumes.
export function projectWithUMAP(
    matrix: EmbeddingMatrix,
    options: UMAPOptions,
    onProgress?: ProjectionProgress,
): RunningProjection {
    const runId = nextRunId++;
    const worker = new Worker(new URL('./umap_worker.js', import.meta.url), { type: 'module' });

    let settled = false;
    const promise = new Promise<Projection2D>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<UMAPWorkerResponse>) => {
            const msg = event.data;
            if (msg.requestId !== runId) return;
            switch (msg.type) {
                case UMAPWorkerResponseType.PROGRESS:
                    onProgress?.(msg.progress, msg.stage);
                    break;
                case UMAPWorkerResponseType.RESULT: {
                    settled = true;
                    const { embedding, count } = msg;
                    const x = new Float32Array(count);
                    const y = new Float32Array(count);
                    for (let i = 0; i < count; ++i) {
                        x[i] = embedding[i * 2];
                        y[i] = embedding[i * 2 + 1];
                    }
                    resolve({ x, y });
                    worker.terminate();
                    break;
                }
                case UMAPWorkerResponseType.ERROR:
                    settled = true;
                    reject(new Error(msg.error));
                    worker.terminate();
                    break;
            }
        };
        worker.onerror = e => {
            if (settled) return;
            settled = true;
            reject(new Error(e.message || 'UMAP worker error'));
            worker.terminate();
        };
    });

    // NB: do NOT transfer matrix.data.buffer. In the zero-copy extraction path it
    // is a subarray VIEW over the live Arrow column's ArrayBuffer; transferring it
    // would detach that buffer on the main thread and corrupt the result table.
    // The structured-clone copy across the worker boundary is cheap next to the
    // UMAP compute (which copies into the wasm heap regardless).
    worker.postMessage({
        messageId: runId,
        type: UMAPWorkerRequestType.RUN,
        params: { data: matrix.data, count: matrix.count, dimension: matrix.dimension, options },
    });

    return {
        promise,
        cancel() {
            if (settled) return;
            settled = true;
            worker.postMessage({ messageId: nextRunId++, type: UMAPWorkerRequestType.CANCEL, runId });
            worker.terminate();
        },
    };
}
