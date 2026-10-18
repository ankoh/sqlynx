import type { EmbedderConfig } from './model.js';

/// ONNX runtime build that transformers.js loads from `<base>/ort/`. The asyncify build works without JSEP/WebGPU.
export const ORT_FILE_STEM = 'ort-wasm-simd-threaded.asyncify';

export function normalizeBaseUrl(baseUrl: string): string {
    const absolute = new URL(baseUrl, self.location.href).href;
    return absolute.endsWith('/') ? absolute : `${absolute}/`;
}

/// Point transformers.js to files on our own hosting. Nothing is fetched from the Hugging Face Hub or a CDN: the page is
/// cross-origin isolated and its CSP only allows same-origin scripts.
///
/// The model is configured as a "remote" host with a template without revision. transformers.js only looks at local
/// paths when they are plain paths, never when they are URLs, which would rule out a model that is hosted on another
/// origin. A cross-origin host has to allow the Range header, transformers.js probes files with `Range: bytes=0-0`.
export function configureTransformers(env: any, baseUrl: string): void {
    const base = normalizeBaseUrl(baseUrl);
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = base;
    env.remotePathTemplate = '{model}/';
    env.useBrowserCache = true;
    // The wasm factory would otherwise be turned into a blob URL, which the CSP does not need to allow this way
    env.useWasmCache = false;
    // A single thread: the runtime would otherwise spawn its thread pool from inside this worker, which can stall on
    // initialization. The model is small enough that threads hardly pay off.
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.wasmPaths = {
        mjs: `${base}ort/${ORT_FILE_STEM}.mjs`,
        wasm: `${base}ort/${ORT_FILE_STEM}.wasm`,
    };
}

export interface DownloadProgress {
    file: string;
    loaded: number;
    total: number;
}

export function pipelineOptions(config: EmbedderConfig, onDownload?: (progress: DownloadProgress) => void) {
    return {
        dtype: config.dtype,
        device: 'wasm' as const,
        progress_callback: (event: any) => {
            if (event?.status === 'progress' && typeof event.file === 'string') {
                onDownload?.({ file: event.file, loaded: event.loaded ?? 0, total: event.total ?? 0 });
            }
        },
    };
}
