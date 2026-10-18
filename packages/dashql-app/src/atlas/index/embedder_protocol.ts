import type { EmbedderConfig } from './model.js';
import type { DownloadProgress } from './transformers_env.js';

/// Message protocol of the embedder worker, same convention as the UMAP worker: typed requests correlated by id.
export enum EmbedderRequestType {
    INIT = 'INIT',
    EMBED = 'EMBED',
}

export enum EmbedderResponseType {
    READY = 'READY',
    DOWNLOAD = 'DOWNLOAD',
    PROGRESS = 'PROGRESS',
    RESULT = 'RESULT',
    ERROR = 'ERROR',
}

export type EmbedderRequest =
    | { readonly id: number; readonly type: EmbedderRequestType.INIT; readonly baseUrl: string; readonly config: EmbedderConfig }
    | { readonly id: number; readonly type: EmbedderRequestType.EMBED; readonly texts: string[] };

export type EmbedderResponse =
    | { readonly id: number; readonly type: EmbedderResponseType.READY; readonly dim: number }
    | { readonly id: number; readonly type: EmbedderResponseType.DOWNLOAD; readonly progress: DownloadProgress }
    | { readonly id: number; readonly type: EmbedderResponseType.PROGRESS; readonly done: number; readonly total: number }
    /// count * dim row-major, L2-normalized
    | { readonly id: number; readonly type: EmbedderResponseType.RESULT; readonly data: Float32Array; readonly count: number }
    | { readonly id: number; readonly type: EmbedderResponseType.ERROR; readonly error: string };
