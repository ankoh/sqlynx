import { ClientOptions, HttpClient } from './http_client.js';
import { Logger } from './logger.js';

export enum NativeHttpServerStreamBatchEvent {
    StreamFailed = "StreamFailed",
    StreamFinished = "StreamFinished",
    FlushAfterClose = "FlushAfterClose",
    FlushAfterTimeout = "FlushAfterTimeout",
    FlushAfterBytes = "FlushAfterBytes",
}

// export class NativeHttpFetchResponse implements Response {
// 
// }

export class NativeHttpClient implements HttpClient {
    logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    public async fetch(input: URL | Request | string, init?: RequestInit & ClientOptions): Promise<Response> {
        throw new Error("foo");
    }
}

