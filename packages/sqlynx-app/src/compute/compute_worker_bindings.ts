import * as arrow from 'apache-arrow';
import * as pb from '@ankoh/sqlynx-protobuf';

import { Logger } from "../platform/logger.js";
import { ComputeWorkerRequestType, ComputeWorkerResponseType, ComputeWorkerResponseVariant, ComputeWorkerTask, ComputeWorkerTaskReturnType, ComputeWorkerTaskVariant } from "./compute_worker_request.js";

const LOG_CTX = "compute_worker";

export type WorkerEventChannel = "message" | "error" | "close";

export interface MessageEventLike<T = any> {
    data: T
}

export interface WorkerLike {
    /// Terminate a worker
    terminate(): void;
    /// Post a message to the worker
    postMessage(message: any, transfer: Transferable[]): void;
    /// Register an event listener for the worker
    addEventListener(channel: WorkerEventChannel, handler: (event: MessageEventLike) => void): void;
    /// Remove an event listener from the worker
    removeEventListener(channel: WorkerEventChannel, handler: (event: MessageEventLike) => void): void;
}

export class ComputeWorkerBindings {
    /// The logger
    protected readonly logger: Logger;
    /// The worker
    public worker: WorkerLike | null;
    /// The promise for the worker shutdown
    protected workerShutdownPromise: Promise<null> | null = null;
    /// Make the worker as terminated
    protected workerShutdownResolver: (value: PromiseLike<null> | null) => void = () => { };

    /// The message handler
    protected readonly onMessageHandler: (event: MessageEventLike) => void;
    /// The error handler
    protected readonly onErrorHandler: (event: MessageEventLike) => void;
    /// The close handler
    protected readonly onCloseHandler: () => void;
    /// Instantiate the module
    protected onInstantiationProgress: ((p: any) => void)[] = [];

    /// The next message id
    protected nextMessageId = 0;
    /// The pending requests
    protected pendingRequests: Map<number, ComputeWorkerTaskVariant> = new Map();
    /// The next scan id
    public nextScanId = 0;
    /// The active scans
    public activeScans: Map<number, AsyncDataFrameScan> = new Map();

    constructor(logger: Logger, worker: WorkerLike | null = null) {
        this.logger = logger;
        this.worker = null;
        this.onMessageHandler = this.onMessage.bind(this);
        this.onErrorHandler = this.onError.bind(this);
        this.onCloseHandler = this.onClose.bind(this);
        this.onInstantiationProgress = [];
        if (worker != null) this.attach(worker);
    }

    /// Attach the worker
    public attach(worker: WorkerLike): void {
        this.worker = worker;
        this.worker.addEventListener('message', this.onMessageHandler);
        this.worker.addEventListener('error', this.onErrorHandler);
        this.worker.addEventListener('close', this.onCloseHandler);
        this.workerShutdownPromise = new Promise<null>(
            (resolve: (value: PromiseLike<null> | null) => void, _reject: (reason?: void) => void) => {
                this.workerShutdownResolver = resolve;
            },
        );
    }

    /// Detach from the worker
    public detach(): void {
        if (!this.worker) return;
        this.worker.removeEventListener('message', this.onMessageHandler);
        this.worker.removeEventListener('error', this.onErrorHandler);
        this.worker.removeEventListener('close', this.onCloseHandler);
        this.worker = null;
        this.workerShutdownResolver(null);
        this.workerShutdownPromise = null;
        this.workerShutdownResolver = () => { };
    }

    /// Kill the worker
    public async terminate(): Promise<void> {
        if (!this.worker) return;
        this.worker.terminate();
        //await this._workerShutdownPromise; TODO deadlocking in karma?
        this.worker = null;
        this.workerShutdownPromise = null;
        this.workerShutdownResolver = () => { };
    }

    /// Post a task
    public async postTask<W extends ComputeWorkerTaskVariant>(
        task: W,
        transfer: ArrayBuffer[] = [],
    ): Promise<ComputeWorkerTaskReturnType<W>> {
        if (!this.worker) {
            console.error('cannot send a message since the worker is not set!');
            return undefined as any;
        }
        const mid = this.nextMessageId++;
        this.pendingRequests.set(mid, task);
        this.worker.postMessage(
            {
                messageId: mid,
                type: task.type,
                data: task.data,
            },
            transfer,
        );
        return (await task.promise) as ComputeWorkerTaskReturnType<W>;
    }

    /// Received a message
    protected onMessage(event: MessageEventLike): void {
        // First process those response type that don't have a registered task
        const response = event.data as ComputeWorkerResponseVariant;
        switch (response.type) {
            // Request failed?
            case ComputeWorkerResponseType.LOG: {
                this.logger.push(response.data);
                return;
            }
            // Call progress callback
            case ComputeWorkerResponseType.INSTANTIATE_PROGRESS: {
                for (const p of this.onInstantiationProgress) {
                    p(response.data);
                }
                return;
            }
            // A message of the dataframe scan
            case ComputeWorkerResponseType.DATAFRAME_SCAN_MESSAGE: {
                const scan = this.activeScans.get(response.data.scanId);
                if (!scan) {
                    this.logger.error("DATAFRAME_SCAN_MESSAGE referred to unknown scan", { "scan": response.data.scanId.toString() }, LOG_CTX);
                    return;
                }
                scan.messageData.push(response.data.buffer);
                return;
            }
            // Finish the dataframe scan
            case ComputeWorkerResponseType.DATAFRAME_SCAN_FINISH: {
                const scan = this.activeScans.get(response.data.scanId);
                if (!scan) {
                    this.logger.error("DATAFRAME_SCAN_FINISH referred to unknown scan", { "scan": response.data.scanId.toString() }, LOG_CTX);
                    return;
                }
                this.activeScans.delete(response.data.scanId);
                try {
                    scan.finish();
                } catch (e: any) {
                    scan.finishWithError(e);
                }
                return;
            }
            // Finish the dataframe scan with an error
            case ComputeWorkerResponseType.DATAFRAME_SCAN_FINISH_WITH_ERROR: {
                const scan = this.activeScans.get(response.data.scanId);
                if (!scan) {
                    this.logger.error("DATAFRAME_SCAN_FINISH_WITH_ERROR referred to unknown scan", { "scan": response.data.scanId.toString() }, LOG_CTX);
                    return;
                }
                this.activeScans.delete(response.data.scanId);
                scan.finishWithError(response.data.error);
                return;
            }
        }

        // Get registered task
        const task = this.pendingRequests.get(response.requestId);
        if (!task) {
            this.logger.error(`unassociated response`, { "request": response.requestId.toString(), "type": response.type.toString() }, LOG_CTX);
            return;
        }
        this.pendingRequests.delete(response.requestId);

        // Request failed?
        if (response.type == ComputeWorkerResponseType.ERROR) {
            // Workaround for Firefox not being able to perform structured-clone on Native Errors
            // https://bugzilla.mozilla.org/show_bug.cgi?id=1556604
            const e = new Error(response.data.message);
            e.name = response.data.name;
            if (Object.getOwnPropertyDescriptor(e, 'stack')?.writable) {
                e.stack = response.data.stack;
            }
            task.promiseRejecter(e);
            return;
        }

        // Otherwise differentiate between the tasks first
        switch (task.type) {
            case ComputeWorkerRequestType.INSTANTIATE:
                this.onInstantiationProgress = [];
                if (response.type == ComputeWorkerResponseType.OK) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case ComputeWorkerRequestType.DATAFRAME_FROM_INGEST: {
                if (response.type == ComputeWorkerResponseType.DATAFRAME_ID) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            }
            case ComputeWorkerRequestType.DATAFRAME_TRANSFORM: {
                if (response.type == ComputeWorkerResponseType.DATAFRAME_ID) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            }
            case ComputeWorkerRequestType.DATAFRAME_DELETE:
            case ComputeWorkerRequestType.DATAFRAME_INGEST_WRITE:
            case ComputeWorkerRequestType.DATAFRAME_INGEST_FINISH:
            case ComputeWorkerRequestType.DATAFRAME_SCAN:
                if (response.type == ComputeWorkerResponseType.OK) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
        }
        task.promiseRejecter(new Error(`unexpected response type ${response.type.toString()} for request of type ${task.type.toString()}`));
    }

    /// Received an error from the worker
    protected onError(event: MessageEventLike): void {
        this.logger.error("error in compute worker", { "error": event.data.toString() }, LOG_CTX);
        console.error(event);
        this.pendingRequests.clear();
    }

    /// The worker was closed
    protected onClose(): void {
        this.workerShutdownResolver(null);
        if (this.pendingRequests.size != 0) {
            this.logger.warn("compute worker terminated", { "pending": this.pendingRequests.size.toString() }, LOG_CTX);
            return;
        }
        this.pendingRequests.clear();
    }


    /// Instantiate the worker
    public async instantiate(url: string) {
        if (!this.worker) return;
        const initStart = performance.now();
        const task = new ComputeWorkerTask<ComputeWorkerRequestType.INSTANTIATE, { url: string }, null>(ComputeWorkerRequestType.INSTANTIATE, { url: url });
        await this.postTask(task);
        const initEnd = performance.now();
        this.logger.info("instantiated compute", { "duration": Math.floor(initEnd - initStart).toString() }, "compute");
    }
    /// Require a worker
    protected requireWorker() {
        if (!this.worker) {
            throw new Error(`worker is null`);
        };
    }
    /// Create an arrow ingest
    public async createArrowIngest(): Promise<AsyncArrowIngest> {
        this.requireWorker();
        const task = new ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_FROM_INGEST, null, { frameId: number }>(ComputeWorkerRequestType.DATAFRAME_FROM_INGEST, null);
        const result = await this.postTask(task);
        const ingest = new AsyncArrowIngest(this.logger, this, result.frameId);
        return ingest;
    }
    /// Create a data frame from a table
    public async createDataFrameFromTable(t: arrow.Table): Promise<AsyncDataFrame> {
        const ingest = await this.createArrowIngest();
        await ingest.writeTable(t);
        const dataFrame = await ingest.finish();
        return dataFrame;
    }
}

export class AsyncDataFrameScan {
    /// The frame id
    frameId: number;
    /// The scan id
    scanId: number;
    /// The message bytes
    messageData: Uint8Array[];
    /// The functin to resolve the finish promise
    promiseResolver: (value: Uint8Array[]) => void;
    /// The functin to reject the finish promise
    promiseRejecter: (value: any) => void;

    constructor(frameId: number, scanId: number, resolve: (value: Uint8Array[]) => void, reject: (value: any) => void) {
        this.frameId = frameId;
        this.scanId = scanId;
        this.messageData = [];
        this.promiseResolver = resolve;
        this.promiseRejecter = reject;
    }
    /// Push message to the scan
    push(data: Uint8Array) {
        this.messageData.push(data);
    }
    /// Finish a data frame scan
    finish() {
        this.promiseResolver(this.messageData);
    }
    /// Finish a data frame scan with an error
    finishWithError(e: any) {
        this.promiseResolver(e);
    }
}

/// An async data frame
export class AsyncDataFrame {
    /// The logger
    logger: Logger;
    /// The worker
    workerBindings: ComputeWorkerBindings;
    /// The frame id
    frameId: number;

    constructor(logger: Logger, worker: ComputeWorkerBindings, frameId: number) {
        this.logger = logger;
        this.workerBindings = worker;
        this.frameId = frameId;
    }

    /// Delete the data frame
    async delete(): Promise<void> {
        const task = new ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_DELETE, { frameId: number }, null>(
            ComputeWorkerRequestType.DATAFRAME_DELETE, { frameId: this.frameId }
        );
        await this.workerBindings.postTask(task);
    }

    /// Transform a data frame
    async transform(transform: pb.sqlynx_compute.pb.DataFrameTransform, stats: AsyncDataFrame | null = null): Promise<AsyncDataFrame> {
        const bytes = transform.toBinary();
        const task = new ComputeWorkerTask<
            ComputeWorkerRequestType.DATAFRAME_TRANSFORM,
            { frameId: number, buffer: Uint8Array, statsFrameId: number | null },
            { frameId: number }>(
                ComputeWorkerRequestType.DATAFRAME_TRANSFORM, { frameId: this.frameId, buffer: bytes, statsFrameId: stats?.frameId ?? null }
            );
        const result = await this.workerBindings.postTask(task);
        return new AsyncDataFrame(this.logger, this.workerBindings, result.frameId);
    }

    /// Scan a data frame
    async readTable(): Promise<arrow.Table> {
        const scanId = this.workerBindings.nextScanId++;
        let promiseResolver: ((value: Uint8Array[]) => void) | null = null;
        let promiseRejecter: ((value: any) => void) | null = null;
        const promise = new Promise<Uint8Array[]>((resolve, reject) => {
            promiseResolver = resolve;
            promiseRejecter = reject
        });
        // Setup the dataframe scan
        const scan = new AsyncDataFrameScan(this.frameId, scanId, promiseResolver!, promiseRejecter!)
        this.workerBindings.activeScans.set(scanId, scan);
        try {
            const task = new ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_SCAN, { frameId: number, scanId: number }, null>(
                ComputeWorkerRequestType.DATAFRAME_SCAN, { frameId: this.frameId, scanId }
            );
            await this.workerBindings.postTask(task);
        } catch (e: any) {
            this.workerBindings.activeScans.delete(scanId);
        }
        // After this point we posted the task and are now waiting for all the DATAFRAME_SCAN_MESSAGEs to arrive.
        // DATAFRAME_SCAN_FINISH or DATAFRAME_SCAN_FINISH_WITH_ERROR will then resolve the promise through the AsyncDataFrameScan.
        const data = await promise;
        // Parse the Arrow IPC stream
        const table = arrow.tableFromIPC(data);
        return table;
    }
}

/// Async Arrow ingest
export class AsyncArrowIngest {
    /// The logger
    logger: Logger;
    /// The worker
    workerBindings: ComputeWorkerBindings;
    /// The frame id
    frameId: number;

    constructor(logger: Logger, worker: ComputeWorkerBindings, frameId: number) {
        this.logger = logger;
        this.workerBindings = worker;
        this.frameId = frameId;
    }

    /// Require a worker
    protected requireWorker() {
        if (!this.workerBindings.worker) {
            throw new Error(`worker is null`);
        };
    }
    /// Read stream data
    async writeStreamBytes(buffer: Uint8Array) {
        this.requireWorker();
        const task = new ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_INGEST_WRITE, { frameId: number, buffer: Uint8Array }, null>(ComputeWorkerRequestType.DATAFRAME_INGEST_WRITE, { frameId: this.frameId, buffer });
        await this.workerBindings.postTask(task);
    }
    /// Insert an arrow table 
    async writeTable(table: arrow.Table): Promise<void> {
        this.requireWorker();
        let data = arrow.tableToIPC(table, "stream");
        const task = new ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_INGEST_WRITE, { frameId: number, buffer: Uint8Array }, null>(ComputeWorkerRequestType.DATAFRAME_INGEST_WRITE, { frameId: this.frameId, buffer: data });
        await this.workerBindings.postTask(task, [data.buffer]);
    }
    /// Finish the arrow ingest
    async finish(): Promise<AsyncDataFrame> {
        this.requireWorker();
        const task = new ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_INGEST_FINISH, { frameId: number }, null>(ComputeWorkerRequestType.DATAFRAME_INGEST_FINISH, { frameId: this.frameId });
        await this.workerBindings.postTask(task, []);
        return new AsyncDataFrame(this.logger, this.workerBindings, this.frameId);

    }
}
