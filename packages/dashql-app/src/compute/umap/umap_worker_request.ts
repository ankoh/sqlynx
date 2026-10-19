import type { UMAPOptions } from '@dashql/umap-wasm';

/// Message protocol for the UMAP web worker.
///
/// Follows the DashQL worker request convention:
/// typed request/response variants correlated by a numeric messageId — NOT Comlink.
/// A single RUN request streams zero or more PROGRESS responses (same requestId)
/// followed by exactly one RESULT or ERROR. A CANCEL request abandons the in-flight
/// run and destroys the UMAP instance.

export enum UMAPWorkerRequestType {
    RUN = 'RUN',
    CANCEL = 'CANCEL',
}

export enum UMAPWorkerResponseType {
    PROGRESS = 'PROGRESS',
    RESULT = 'RESULT',
    ERROR = 'ERROR',
}

/// Parameters for a projection run. `data` is the row-major N×D matrix; `count`
/// and `dimension` describe its shape; `options` are forwarded to createUMAP.
export interface UMAPRunParams {
    data: Float32Array;
    count: number;
    dimension: number;
    options: UMAPOptions;
}

export type UMAPWorkerRequest =
    | { readonly messageId: number; readonly type: UMAPWorkerRequestType.RUN; readonly params: UMAPRunParams }
    | { readonly messageId: number; readonly type: UMAPWorkerRequestType.CANCEL; readonly runId: number };

export type UMAPWorkerResponse =
    | {
          readonly requestId: number;
          readonly type: UMAPWorkerResponseType.PROGRESS;
          readonly progress: number;
          readonly stage: string;
      }
    | {
          readonly requestId: number;
          readonly type: UMAPWorkerResponseType.RESULT;
          /// N×2 row-major embedding.
          readonly embedding: Float32Array;
          readonly count: number;
      }
    | { readonly requestId: number; readonly type: UMAPWorkerResponseType.ERROR; readonly error: string };
