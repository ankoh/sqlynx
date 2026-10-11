import type { BatchRequest, BatchResult } from './batch.js';

export interface BatchWorkerRequest {
    requestId: number;
    request: BatchRequest;
}

export type BatchWorkerResponse =
    | { requestId: number; result: BatchResult }
    | { requestId: number; error: string };
