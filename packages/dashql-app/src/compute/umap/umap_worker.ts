/// UMAP web worker: runs the vendored Rust→wasm UMAP projection off the main
/// thread. See umap_worker_request.ts for the message protocol and umap_projection.ts
/// for the main-thread driver.
///
/// The wasm module carries the wgpu → WebGPU `gpu` path (kNN + layout compute
/// shaders). When the worker's `navigator.gpu` exposes an adapter we opt in with
/// `gpu: true`; the Rust side (GpuContext::new / OptimizeGpuContext::new both return
/// Option) still falls back to CPU internally if the adapter request fails, so the
/// capability check is an optimization, not a correctness guard.
///
/// The wasm CPU fallback is single-threaded (rayon degrades to sequential on wasm32),
/// so a projection of a large embedding table is seconds-scale and MUST NOT block
/// the UI. Progress is streamed back so the notebook status/log surface can show it.

// eslint-disable-next-line import/no-unresolved -- resolved by the bundler alias to dependencies/umap-wasm/index.js
import { createUMAP } from '@dashql/umap-wasm';

import {
    UMAPWorkerRequest,
    UMAPWorkerRequestType,
    UMAPWorkerResponse,
    UMAPWorkerResponseType,
} from './umap_worker_request.js';

/// Probe WebGPU once per worker: is an adapter actually obtainable? `navigator.gpu`
/// can exist while `requestAdapter()` returns null (blocklisted GPU, headless, etc.),
/// so we request an adapter rather than just feature-detecting the object. Cached as a
/// promise so concurrent RUNs share the single probe.
let gpuAvailable: Promise<boolean> | null = null;
function webgpuAvailable(): Promise<boolean> {
    if (gpuAvailable == null) {
        // eslint-disable-next-line no-restricted-globals
        const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
        gpuAvailable = gpu
            ? gpu
                  .requestAdapter({ powerPreference: 'high-performance' })
                  .then((adapter) => adapter != null)
                  .catch(() => false)
            : Promise.resolve(false);
    }
    return gpuAvailable;
}

/// The currently running projection, if any. Only one runs at a time; a CANCEL
/// flips `cancelled` so the driver stops caring about a late RESULT, and the UMAP
/// instance is destroyed as soon as run() settles.
let active: { requestId: number; cancelled: boolean } | null = null;

function post(msg: UMAPWorkerResponse, transfer?: Transferable[]): void {
    // eslint-disable-next-line no-restricted-globals
    (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

async function run(requestId: number, params: UMAPWorkerRequest & { type: UMAPWorkerRequestType.RUN }): Promise<void> {
    const state = { requestId, cancelled: false };
    active = state;

    const { data, count, dimension, options } = params.params;
    // Prefer the GPU path when the caller hasn't forced a choice and this worker's
    // WebGPU adapter is reachable. An explicit options.gpu (true/false) wins.
    const gpu = options.gpu ?? (await webgpuAvailable());
    if (state.cancelled) return;
    let umap: Awaited<ReturnType<typeof createUMAP>> | null = null;
    try {
        umap = await createUMAP(count, dimension, 2, data, {
            ...options,
            gpu,
            progress: (progress: number, stage: string) => {
                if (state.cancelled) return;
                post({ requestId, type: UMAPWorkerResponseType.PROGRESS, progress, stage });
            },
        });
        if (state.cancelled) return;

        // Anneal the layout to completion.
        await umap.run();
        if (state.cancelled) return;

        // Copy the embedding out of the reused wasm buffer into a transferable one.
        const embedding = new Float32Array(umap.embedding);
        post(
            { requestId, type: UMAPWorkerResponseType.RESULT, embedding, count },
            [embedding.buffer],
        );
    } catch (e: unknown) {
        if (!state.cancelled) {
            post({ requestId, type: UMAPWorkerResponseType.ERROR, error: e instanceof Error ? e.message : String(e) });
        }
    } finally {
        umap?.destroy();
        if (active === state) active = null;
    }
}

// eslint-disable-next-line no-restricted-globals
self.onmessage = (event: MessageEvent<UMAPWorkerRequest>) => {
    const req = event.data;
    switch (req.type) {
        case UMAPWorkerRequestType.RUN:
            void run(req.messageId, req);
            break;
        case UMAPWorkerRequestType.CANCEL:
            if (active && active.requestId === req.runId) {
                active.cancelled = true;
            }
            break;
    }
};
