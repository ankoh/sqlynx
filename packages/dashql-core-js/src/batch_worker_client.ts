import type { BatchRequest, BatchResult } from './batch.js';
import type { BatchWorkerRequest, BatchWorkerResponse } from './batch_worker_protocol.js';

/// Owns the supplied worker. Disposing or a transport failure rejects every outstanding request.
export class DashQLBatchWorker {
    private nextRequestId = 1;
    private closed: Error | null = null;
    private initialization: Promise<void> | null = null;
    private initialized = false;
    private readonly pending = new Map<number, {
        resolve: (result: BatchResult) => void;
        reject: (error: Error) => void;
    }>();

    constructor(private readonly worker: Worker) {
        worker.addEventListener('message', this.onMessage);
        worker.addEventListener('error', this.onError);
        worker.addEventListener('messageerror', this.onMessageError);
    }

    get isClosed(): boolean {
        return this.closed !== null;
    }

    get isInitialized(): boolean {
        return this.initialized && !this.isClosed;
    }

    /// An empty request loads the worker's Core without preparing any scripts.
    initialize(): Promise<void> {
        if (this.closed) return Promise.reject(this.closed);
        this.initialization ??= this.processBatch({ scripts: [] }).then(() => { this.initialized = true; }, error => {
            this.initialization = null;
            throw error;
        });
        return this.initialization;
    }

    processBatch(request: BatchRequest): Promise<BatchResult> {
        if (this.closed) return Promise.reject(this.closed);
        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            try {
                // Context buffers belong to the caller and must not be detached.
                const message: BatchWorkerRequest = { requestId, request };
                this.worker.postMessage(message);
            } catch (error) {
                this.pending.delete(requestId);
                reject(error);
            }
        });
    }

    dispose(): void {
        this.close(new Error('Core batch worker was disposed'));
    }

    private readonly onMessage = (event: MessageEvent<BatchWorkerResponse>): void => {
        const response = event.data;
        const pending = this.pending.get(response.requestId);
        if (!pending) return;
        this.pending.delete(response.requestId);
        if ('error' in response) pending.reject(new Error(response.error));
        else pending.resolve(response.result);
    };

    private readonly onError = (event: ErrorEvent): void => {
        this.close(new Error(event.message || 'Core batch worker failed'));
    };

    private readonly onMessageError = (): void => {
        this.close(new Error('Core batch worker response could not be decoded'));
    };

    private close(error: Error): void {
        if (this.closed) return;
        this.closed = error;
        this.worker.removeEventListener('message', this.onMessage);
        this.worker.removeEventListener('error', this.onError);
        this.worker.removeEventListener('messageerror', this.onMessageError);
        this.worker.terminate();
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
}

export function createBatchWorker(): DashQLBatchWorker {
    return new DashQLBatchWorker(new Worker(new URL('./batch_worker.js', import.meta.url), { type: 'module' }));
}
