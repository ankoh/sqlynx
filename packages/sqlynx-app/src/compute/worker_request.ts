export enum WorkerRequestType {
    INSTANTIATE = 'INSTANTIATE',
    DATAFRAME_DELETE = 'DATAFRAME_DELETE',
    DATAFRAME_FROM_INGEST = 'DATAFRAME_FROM_INGEST',
    DATAFRAME_INGEST_READ = 'DATAFRAME_INGEST_READ',
    DATAFRAME_INGEST_FINISH = 'DATAFRAME_INGEST_FINISH',
    DATAFRAME_SCAN = 'DATAFRAME_SCAN',
}

export enum WorkerResponseType {
    OK = 'OK',
    ERROR = 'ERROR',
    LOG = 'LOG',
    DATAFRAME_SCAN_MESSAGE = 'DATAFRAME_SCAN_MESSAGE',
    DATAFRAME_SCAN_FINISH = 'DATAFRAME_SCAN_MESSAGE',
}

export type WorkerRequest<T, P> = {
    readonly messageId: number;
    readonly type: T;
    readonly data: P;
};

export type WorkerResponse<T, P> = {
    readonly messageId: number;
    readonly requestId: number;
    readonly type: T;
    readonly data: P;
};

export type WorkerTaskReturnType<T extends WorkerTaskVariant> = T extends WorkerTask<any, any, infer P> ? P : never;

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

export type WorkerRequestVariant =
    | WorkerRequest<WorkerRequestType.INSTANTIATE, null>
    | WorkerRequest<WorkerRequestType.DATAFRAME_DELETE, null>
    | WorkerRequest<WorkerRequestType.DATAFRAME_FROM_INGEST, null>
    | WorkerRequest<WorkerRequestType.DATAFRAME_INGEST_READ, null>
    | WorkerRequest<WorkerRequestType.DATAFRAME_INGEST_FINISH, null>
    | WorkerRequest<WorkerRequestType.DATAFRAME_SCAN, null>
    ;

export type WorkerResponseVariant =
    | WorkerResponse<WorkerResponseType.OK, null>
    | WorkerResponse<WorkerResponseType.ERROR, null>
    | WorkerResponse<WorkerResponseType.LOG, null>
    | WorkerResponse<WorkerResponseType.DATAFRAME_SCAN_MESSAGE, Uint8Array>
    | WorkerResponse<WorkerResponseType.DATAFRAME_SCAN_FINISH, null>
    ;

export type WorkerTaskVariant =
    | WorkerTask<WorkerRequestType.INSTANTIATE, null, null>
    | WorkerTask<WorkerRequestType.DATAFRAME_DELETE, null, null>
    | WorkerTask<WorkerRequestType.DATAFRAME_FROM_INGEST, null, null>
    | WorkerTask<WorkerRequestType.DATAFRAME_INGEST_READ, null, null>
    | WorkerTask<WorkerRequestType.DATAFRAME_INGEST_FINISH, null, null>
    | WorkerTask<WorkerRequestType.DATAFRAME_SCAN, null, null>
    ;
