import { LogRecord } from "../platform/log_buffer.js";

export enum ComputeWorkerRequestType {
    PING = 'PING',
    INSTANTIATE = 'INSTANTIATE',
    DATAFRAME_DELETE = 'DATAFRAME_DELETE',
    DATAFRAME_FROM_INGEST = 'DATAFRAME_FROM_INGEST',
    DATAFRAME_INGEST_READ = 'DATAFRAME_INGEST_READ',
    DATAFRAME_INGEST_FINISH = 'DATAFRAME_INGEST_FINISH',
    DATAFRAME_SCAN = 'DATAFRAME_SCAN',
}

export enum ComputeWorkerResponseType {
    OK = 'OK',
    ERROR = 'ERROR',
    LOG = 'LOG',
    INSTANTIATE_PROGRESS = 'INSTANTIATE_PROGRESS',
    DATAFRAME_SCAN_MESSAGE = 'DATAFRAME_SCAN_MESSAGE',
    DATAFRAME_SCAN_FINISH = 'DATAFRAME_SCAN_MESSAGE',
}

export type ComputeWorkerRequest<T, P> = {
    readonly messageId: number;
    readonly type: T;
    readonly data: P;
};

export type ComputeWorkerResponse<T, P> = {
    readonly messageId: number;
    readonly requestId: number;
    readonly type: T;
    readonly data: P;
};

export class ComputeWorkerTask<T, D, P> {
    readonly type: T;
    readonly data: D;
    promise: Promise<P>;
    promiseResolver: (value: P | PromiseLike<P>) => void = () => { };
    promiseRejecter: (value: any) => void = () => { };

    constructor(type: T, data: D) {
        this.type = type;
        this.data = data;
        this.promise = new Promise<P>(
            (resolve: (value: P | PromiseLike<P>) => void, reject: (reason?: void) => void) => {
                this.promiseResolver = resolve;
                this.promiseRejecter = reject;
            },
        );
    }
}

export type ComputeWorkerRequestVariant =
    | ComputeWorkerRequest<ComputeWorkerRequestType.PING, null>
    | ComputeWorkerRequest<ComputeWorkerRequestType.INSTANTIATE, { url: string }>
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_DELETE, { frameId: number }>
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_FROM_INGEST, { frameId: number }>
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_INGEST_READ, { frameId: number, buffer: Uint8Array }>
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_INGEST_FINISH, { frameId: number }>
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_SCAN, { frameId: number }>
    ;

export type ComputeWorkerResponseVariant =
    | ComputeWorkerResponse<ComputeWorkerResponseType.OK, null>
    | ComputeWorkerResponse<ComputeWorkerResponseType.ERROR, any>
    | ComputeWorkerResponse<ComputeWorkerResponseType.LOG, LogRecord>
    | ComputeWorkerResponse<ComputeWorkerResponseType.INSTANTIATE_PROGRESS, null>
    | ComputeWorkerResponse<ComputeWorkerResponseType.DATAFRAME_SCAN_MESSAGE, Uint8Array>
    | ComputeWorkerResponse<ComputeWorkerResponseType.DATAFRAME_SCAN_FINISH, null>
    ;

export class WorkerTask<T, D, P> {
    readonly type: T;
    readonly data: D;
    promise: Promise<P>;
    promiseResolver: (value: P | PromiseLike<P>) => void = () => { };
    promiseRejecter: (value: any) => void = () => { };

    constructor(type: T, data: D) {
        this.type = type;
        this.data = data;
        this.promise = new Promise<P>(
            (resolve: (value: P | PromiseLike<P>) => void, reject: (reason?: void) => void) => {
                this.promiseResolver = resolve;
                this.promiseRejecter = reject;
            },
        );
    }
}

export type ComputeWorkerTaskReturnType<T extends ComputeWorkerTaskVariant> = T extends WorkerTask<any, any, infer P> ? P : never;

export type ComputeWorkerTaskVariant =
    | WorkerTask<ComputeWorkerRequestType.PING, null, null>
    | WorkerTask<ComputeWorkerRequestType.INSTANTIATE, { url: string }, null>
    | WorkerTask<ComputeWorkerRequestType.DATAFRAME_DELETE, { url: string }, null>
    | WorkerTask<ComputeWorkerRequestType.DATAFRAME_INGEST_READ, { url: string }, null>
    | WorkerTask<ComputeWorkerRequestType.DATAFRAME_INGEST_FINISH, { url: string }, null>
    | WorkerTask<ComputeWorkerRequestType.DATAFRAME_SCAN, { url: string }, null>
    ;
