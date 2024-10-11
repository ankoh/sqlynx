import * as compute from '@ankoh/sqlynx-compute';

import { ComputeWorkerRequestType, ComputeWorkerRequestVariant, ComputeWorkerResponseType, ComputeWorkerResponseVariant } from "./compute_worker_request.js";

export interface WorkerGlobalsLike {
    /// Post a message to the worker
    postMessage(message: any, transfer: Transferable[]): void;
    /// Register an event listener for the worker
    addEventListener(channel: "message", handler: (event: MessageEvent) => void): void;
    /// Remove an event listener from the worker
    removeEventListener(channel: "message", handler: (event: MessageEvent) => void): void;
}

export abstract class ComputeWorker {
    /// The worker globals
    protected workerGlobals: WorkerGlobalsLike;
    /// The next message id
    protected nextMessageId = 0;
    /// The next frame id
    protected nextFrameId = 0;
    /// The frame builders
    protected frameBuilders: Map<number, compute.ArrowIngest>;
    /// The frames
    protected frames: Map<number, compute.DataFrame>;

    constructor(workerGlobals: WorkerGlobalsLike) {
        this.workerGlobals = workerGlobals;
        this.nextMessageId = 0;
        this.nextFrameId = 0;
        this.frameBuilders = new Map();
        this.frames = new Map();
    }

    /// Post a response to the main thread
    protected postMessage(response: ComputeWorkerResponseVariant, transfer: any[]): void {
        this.workerGlobals.postMessage(response, transfer);
    }

    /// Send plain OK without further data
    protected sendOK(request: ComputeWorkerRequestVariant): void {
        this.postMessage(
            {
                messageId: this.nextMessageId++,
                requestId: request.messageId,
                type: ComputeWorkerResponseType.OK,
                data: null,
            },
            [],
        );
    }
    /// Fail with an error
    protected failWith(request: ComputeWorkerRequestVariant, e: Error): void {
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
                type: ComputeWorkerResponseType.ERROR,
                data: obj,
            },
            [],
        );
        return;
    }
    /// Process a request from the main thread
    public async onMessage(request: ComputeWorkerRequestVariant): Promise<void> {
        // Instantiate the module
        switch (request.type) {
            case ComputeWorkerRequestType.PING:
                this.sendOK(request);
                return;
            case ComputeWorkerRequestType.INSTANTIATE:
                try {
                    compute.default(request.data.url);
                    this.sendOK(request);
                } catch (e: any) {
                    this.failWith(request, e);
                    return;
                }
            default:
                break;
        }

        // Dispatch the request
        try {
            switch (request.type) {
                case ComputeWorkerRequestType.DATAFRAME_FROM_INGEST: {
                    const frameId = this.nextFrameId++;
                    const frameBuilder = new compute.ArrowIngest();
                    this.frameBuilders.set(frameId, frameBuilder);
                    this.sendOK(request);
                    break;
                }
                case ComputeWorkerRequestType.DATAFRAME_INGEST_WRITE: {
                    const ingest = this.frameBuilders.get(request.data.frameId);
                    if (!ingest) {
                        this.failWith(request, new Error(`unknown dataframe id ${request.data.frameId}`));
                        return;
                    }
                    try {
                        ingest.read(request.data.buffer);
                        this.sendOK(request);
                    } catch (e: any) {
                        this.failWith(request, e);
                        return;
                    }
                    break;
                }
                case ComputeWorkerRequestType.DATAFRAME_INGEST_FINISH: {
                    const ingest = this.frameBuilders.get(request.data.frameId);
                    if (!ingest) {
                        this.failWith(request, new Error(`unknown dataframe id ${request.data.frameId}`));
                        return;
                    }
                    try {
                        const frame = ingest.finish();
                        this.frames.set(request.data.frameId, frame);
                        this.sendOK(request);
                    } catch (e: any) {
                        this.failWith(request, e);
                        return;
                    }
                    break;
                }
                case ComputeWorkerRequestType.DATAFRAME_SCAN: {
                    const frame = this.frames.get(request.data.frameId);
                    if (!frame) {
                        this.failWith(request, new Error(`unknown dataframe id ${request.data.frameId}`));
                        return;
                    }
                    try {
                        const scan = frame.createIpcStream();
                        while (true) {
                            const data = scan.next(frame)!;
                            if (data === undefined) {
                                this.postMessage({
                                    messageId: this.nextMessageId++,
                                    requestId: request.messageId,
                                    type: ComputeWorkerResponseType.DATAFRAME_SCAN_FINISH,
                                    data: { scanId: request.data.scanId },
                                }, []);
                                break;
                            } else {
                                this.postMessage({
                                    messageId: this.nextMessageId++,
                                    requestId: request.messageId,
                                    type: ComputeWorkerResponseType.DATAFRAME_SCAN_MESSAGE,
                                    data: {
                                        scanId: request.data.scanId,
                                        buffer: data
                                    },
                                }, [data.buffer]);
                            }
                        }
                        this.sendOK(request);
                    } catch (e: any) {
                        this.failWith(request, e);
                        return;
                    }
                    break;
                }
                case ComputeWorkerRequestType.DATAFRAME_DELETE: {
                    const frame = this.frames.get(request.data.frameId);
                    if (frame) {
                        this.frames.delete(request.data.frameId);
                        frame.free();
                    }
                    this.sendOK(request);
                    return;
                }
                default:
                    break;
            }

        } catch (e: any) {
            console.log(e);
            return this.failWith(request, e);
        }
    }
}
