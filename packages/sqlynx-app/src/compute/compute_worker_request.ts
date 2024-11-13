import { LogRecord } from "../platform/log_buffer.js";

export enum ComputeWorkerRequestType {
    PING = 'PING',
    INSTANTIATE = 'INSTANTIATE',
    DATAFRAME_DELETE = 'DATAFRAME_DELETE',
    DATAFRAME_FROM_INGEST = 'DATAFRAME_FROM_INGEST',
    DATAFRAME_INGEST_WRITE = 'DATAFRAME_INGEST_WRITE',
    DATAFRAME_INGEST_FINISH = 'DATAFRAME_INGEST_FINISH',
    DATAFRAME_TRANSFORM = 'DATAFRAME_TRANSFORM',
    DATAFRAME_SCAN = 'DATAFRAME_SCAN',
}

export enum ComputeWorkerResponseType {
    OK = 'OK',
    ERROR = 'ERROR',
    LOG = 'LOG',
    INSTANTIATE_PROGRESS = 'INSTANTIATE_PROGRESS',
    DATAFRAME_ID = 'DATAFRAME_ID',
    DATAFRAME_SCAN_MESSAGE = 'DATAFRAME_SCAN_MESSAGE',
    DATAFRAME_SCAN_FINISH = 'DATAFRAME_SCAN_FINISH',
    DATAFRAME_SCAN_FINISH_WITH_ERROR = 'DATAFRAME_SCAN_FINISH_WITH_ERROR',
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

export class ComputeWorkerTask<T extends ComputeWorkerRequestType, D, P> {
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
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_FROM_INGEST, null>
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_INGEST_WRITE, { frameId: number, buffer: Uint8Array }>
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_INGEST_FINISH, { frameId: number }>
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_SCAN, { frameId: number, scanId: number }>
    | ComputeWorkerRequest<ComputeWorkerRequestType.DATAFRAME_TRANSFORM, { frameId: number, buffer: Uint8Array }>
    ;

export type ComputeWorkerResponseVariant =
    | ComputeWorkerResponse<ComputeWorkerResponseType.OK, null>
    | ComputeWorkerResponse<ComputeWorkerResponseType.ERROR, any>
    | ComputeWorkerResponse<ComputeWorkerResponseType.LOG, LogRecord>
    | ComputeWorkerResponse<ComputeWorkerResponseType.INSTANTIATE_PROGRESS, null>
    | ComputeWorkerResponse<ComputeWorkerResponseType.DATAFRAME_ID, { frameId: number }>
    | ComputeWorkerResponse<ComputeWorkerResponseType.DATAFRAME_SCAN_MESSAGE, { scanId: number, buffer: Uint8Array }>
    | ComputeWorkerResponse<ComputeWorkerResponseType.DATAFRAME_SCAN_FINISH, { scanId: number }>
    | ComputeWorkerResponse<ComputeWorkerResponseType.DATAFRAME_SCAN_FINISH_WITH_ERROR, { scanId: number, error: any }>
    ;

export type ComputeWorkerTaskVariant =
    | ComputeWorkerTask<ComputeWorkerRequestType.PING, null, null>
    | ComputeWorkerTask<ComputeWorkerRequestType.INSTANTIATE, { url: string }, null>
    | ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_DELETE, { frameId: number }, null>
    | ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_FROM_INGEST, null, { frameId: number }>
    | ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_INGEST_WRITE, { frameId: number }, null>
    | ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_INGEST_FINISH, { frameId: number }, null>
    | ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_TRANSFORM, { frameId: number, buffer: Uint8Array }, { frameId: number }>
    | ComputeWorkerTask<ComputeWorkerRequestType.DATAFRAME_SCAN, { frameId: number, scanId: number }, null>
    ;

export type ComputeWorkerTaskReturnType<T extends ComputeWorkerTaskVariant> = T extends ComputeWorkerTask<any, any, infer P> ? P : never;
