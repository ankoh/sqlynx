import { WorkerRequestType, WorkerRequestVariant, WorkerResponseType, WorkerResponseVariant } from "./compute_worker_request.js";

export abstract class WorkerDispatcher {
    /// The next message id
    protected nextMessageId = 0;

    /// Post a response to the main thread
    protected postMessage(response: WorkerResponseVariant, transfer: any[]): void {
        globalThis.postMessage(response, "", transfer);
    }

    /// Send plain OK without further data
    protected sendOK(request: WorkerRequestVariant): void {
        this.postMessage(
            {
                messageId: this.nextMessageId++,
                requestId: request.messageId,
                type: WorkerResponseType.OK,
                data: null,
            },
            [],
        );
    }

    /// Fail with an error
    protected failWith(request: WorkerRequestVariant, e: Error): void {
        // Workaround for Firefox not being able to perform structured-clone on Native Errors
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1556604
        const obj: any = {
            name: e.name,
            message: e.message,
            stack: e.stack || undefined,
        };
        this.postMessage(
            {
                messageId: this.nextMessageId++,
                requestId: request.messageId,
                type: WorkerResponseType.ERROR,
                data: obj,
            },
            [],
        );
        return;
    }

    /// Process a request from the main thread
    public async onMessage(request: WorkerRequestVariant): Promise<void> {
        // Instantiate the module
        switch (request.type) {
            case WorkerRequestType.INSTANTIATE:
                return;
            default:
                break;
        }

        // Dispatch the request
        try {
            switch (request.type) {
                case WorkerRequestType.DATAFRAME_FROM_INGEST:
                case WorkerRequestType.DATAFRAME_INGEST_READ:
                case WorkerRequestType.DATAFRAME_INGEST_FINISH:
                case WorkerRequestType.DATAFRAME_SCAN:
                case WorkerRequestType.DATAFRAME_DELETE:
                    return;
                default:
                    break;
            }

        } catch (e: any) {
            console.log(e);
            return this.failWith(request, e);
        }
    }
}
