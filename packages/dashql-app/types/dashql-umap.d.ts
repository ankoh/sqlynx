// Ambient declaration for the vendored UMAP wasm module. The real types live in
// dependencies/umap-wasm/index.d.ts (staged by the :dep_umap_wasm genrule), but
// that tree only exists after a Bazel build, so mirror the surface here for tsc.
declare module '@dashql/umap-wasm' {
    export interface UMAPOptions {
        metric?: 'euclidean' | 'cosine';
        initializeMethod?: 'spectral' | 'random';
        optimizer?: 'sgd' | 'momentum';
        localConnectivity?: number;
        mixRatio?: number;
        spread?: number;
        minDist?: number;
        repulsionStrength?: number;
        nEpochs?: number;
        learningRate?: number;
        negativeSampleRate?: number;
        nNeighbors?: number;
        seed?: number;
        progress?: (progress: number, stage: string) => void;
        gpu?: boolean;
    }

    export interface UMAP {
        readonly inputDim: number;
        readonly outputDim: number;
        readonly epoch: number;
        readonly embedding: Float32Array;
        readonly knnIndices: Int32Array;
        readonly knnDistances: Float32Array;
        run(): Promise<void>;
        step(nEpochs?: number): Promise<void>;
        setParameters(
            params: Pick<
                UMAPOptions,
                'learningRate' | 'repulsionStrength' | 'negativeSampleRate' | 'minDist' | 'spread'
            >,
        ): void;
        setOptimizer(optimizer: 'sgd' | 'momentum'): void;
        reset(method?: 'spectral' | 'random'): void;
        destroy(): void;
    }

    export function createUMAP(
        count: number,
        inputDim: number,
        outputDim: number,
        data: Float32Array,
        options?: UMAPOptions,
    ): Promise<UMAP>;

    export type UMAPFromKNNOptions = Omit<UMAPOptions, 'metric' | 'nNeighbors'>;

    export function createUMAPFromKNN(
        count: number,
        outputDim: number,
        knnIndices: Int32Array,
        knnDistances: Float32Array,
        options?: UMAPFromKNNOptions,
    ): Promise<UMAP>;

    export interface NNDescentOptions {
        metric?: 'euclidean' | 'cosine';
        nNeighbors?: number;
        nTrees?: number;
        nIters?: number;
        delta?: number;
        treeInit?: boolean;
        epsilon?: number;
        seed?: number;
        progress?: (progress: number, stage: string) => void;
        gpu?: boolean;
    }

    export interface NNDescentQueryResult {
        indices: Int32Array;
        distances: Float32Array;
    }

    export interface NNDescentResult {
        queryByIndex(index: number, k: number): NNDescentQueryResult;
        queryByVector(data: Float32Array, k: number): NNDescentQueryResult;
        destroy(): void;
    }

    export function createNNDescent(
        count: number,
        inputDim: number,
        data: Float32Array,
        options?: NNDescentOptions,
    ): Promise<NNDescentResult>;
}
