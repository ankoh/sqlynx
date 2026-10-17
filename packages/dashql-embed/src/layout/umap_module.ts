import { readFile } from 'node:fs/promises';

/// The part of //packages/dashql-umap:node_module that the layout uses
export interface UmapOptions {
    metric?: 'euclidean' | 'cosine';
    nNeighbors?: number;
    minDist?: number;
    nEpochs?: number;
    learningRate?: number;
    seed?: number;
    initialEmbedding?: Float32Array;
}

export interface UmapInstance {
    readonly embedding: Float32Array;
    run(): Promise<void>;
    destroy(): void;
}

export interface UmapModule {
    createUMAP(count: number, inputDim: number, outputDim: number, data: Float32Array, options?: UmapOptions): Promise<UmapInstance>;
}

let loading: Promise<UmapModule> | null = null;

/// Load the vendored UMAP wasm module. Bazel stages it at packages/dashql-umap/node, next to this package
/// (the path is the same from src/ and from dist/).
export function loadUmap(): Promise<UmapModule> {
    loading ??= (async () => {
        const root = new URL('../../../dashql-umap/node/', import.meta.url);
        const glue = await import(new URL('pkg/umap_wasm.js', root).href);
        glue.initSync({ module: await readFile(new URL('pkg/umap_wasm_bg.wasm', root)) });
        return (await import(new URL('index.js', root).href)) as UmapModule;
    })();
    return loading;
}
