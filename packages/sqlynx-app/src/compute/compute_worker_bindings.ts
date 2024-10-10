import { Logger } from "../platform/logger.js";
import { ComputeWorkerRequestType, ComputeWorkerResponseType, ComputeWorkerResponseVariant, ComputeWorkerTaskReturnType, ComputeWorkerTaskVariant } from "./compute_worker_request.js";

export class ComputeWorkerBindings {
    /// The logger
    protected readonly logger: Logger;
    /// The worker
    protected worker: Worker | null;
    /// The promise for the worker shutdown
    protected workerShutdownPromise: Promise<null> | null = null;
    /// Make the worker as terminated
    protected workerShutdownResolver: (value: PromiseLike<null> | null) => void = () => { };

    /// The message handler
    protected readonly onMessageHandler: (event: MessageEvent) => void;
    /// The error handler
    protected readonly onErrorHandler: (event: ErrorEvent) => void;
    /// The close handler
    protected readonly onCloseHandler: () => void;
    /// Instantiate the module
    protected onInstantiationProgress: ((p: any) => void)[] = [];

    /** The next message id */
    protected nextMessageId = 0;
    /** The pending requests */
    protected pendingRequests: Map<number, ComputeWorkerTaskVariant> = new Map();


    constructor(logger: Logger, worker: Worker | null = null) {
        this.logger = logger;
        this.worker = null;
        this.onMessageHandler = this.onMessage.bind(this);
        this.onErrorHandler = this.onError.bind(this);
        this.onCloseHandler = this.onClose.bind(this);
        this.onInstantiationProgress = [];
        if (worker != null) this.attach(worker);
    }

    async instantiate() {

    }

    protected attach(worker: Worker): void {
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

    /// Detacht from the worker
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
    protected async postTask<W extends ComputeWorkerTaskVariant>(
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
    protected onMessage(event: MessageEvent): void {
        // Unassociated responses?
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
        }
        // Get associated task
        const task = this.pendingRequests.get(response.requestId);
        if (!task) {
            console.warn(`unassociated response: [${response.requestId}, ${response.type.toString()}]`);
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
            case ComputeWorkerRequestType.DATAFRAME_DELETE:
            case ComputeWorkerRequestType.DATAFRAME_INGEST_READ:
            case ComputeWorkerRequestType.DATAFRAME_INGEST_FINISH:
            case ComputeWorkerRequestType.DATAFRAME_SCAN:
                if (response.type == ComputeWorkerResponseType.OK) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
        }
        task.promiseRejecter(new Error(`unexpected response type: ${response.type.toString()}`));
    }

    /// Received an error from the worker
    protected onError(event: ErrorEvent): void {
        console.error(event);
        console.error(`error in duckdb worker: ${event.message}`);
        this.pendingRequests.clear();
    }

    /// The worker was closed
    protected onClose(): void {
        this.workerShutdownResolver(null);
        if (this.pendingRequests.size != 0) {
            console.warn(`worker terminated with ${this.pendingRequests.size} pending requests`);
            return;
        }
        this.pendingRequests.clear();
    }

}
