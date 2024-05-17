import { HttpClient, HttpFetchResult } from './http_client.js';
import { Logger } from './logger.js';
import { HEADER_NAME_BATCH_TIMEOUT, HEADER_NAME_ENDPOINT, HEADER_NAME_PATH, HEADER_NAME_READ_TIMEOUT, HEADER_NAME_STREAM_ID } from "./native_api_mock.js";

export enum NativeHttpServerStreamBatchEvent {
    StreamFailed = "StreamFailed",
    StreamFinished = "StreamFinished",
    FlushAfterClose = "FlushAfterClose",
    FlushAfterTimeout = "FlushAfterTimeout",
    FlushAfterBytes = "FlushAfterBytes",
}

export interface NativeHttpProxyConfig {
    /// The endpoint URL
    proxyEndpoint: URL;
};

export class NativeHttpServerStream implements HttpFetchResult {
    /// The endpoint
    endpoint: NativeHttpProxyConfig;
    /// The stream id
    streamId: number | null;
    /// The headers
    headers: Headers;
    /// The status
    status: number;
    /// The status text
    statusText: string;
    /// The logger
    logger: Logger;

    /// Constructor
    constructor(endpoint: NativeHttpProxyConfig, streamId: number | null, headers: Headers, status: number, statusText: string, logger: Logger) {
        this.headers = headers;
        this.status = status;
        this.statusText = statusText;
        this.endpoint = endpoint;
        this.streamId = streamId;
        this.logger = logger;
    }

    /// Get the response as array buffer
    async arrayBuffer(): Promise<ArrayBuffer> {
        if (this.streamId == null) {
            return new ArrayBuffer(0);
        }
        const url = new URL(this.endpoint.proxyEndpoint);
        url.pathname = `/http/stream/${this.streamId}`;

        const headers = new Headers();
        headers.set(HEADER_NAME_BATCH_TIMEOUT, "1000");
        headers.set(HEADER_NAME_READ_TIMEOUT, "1000");

        const request = new Request(url, {
            method: 'GET',
            headers,
        });
        const response = await fetch(request);
        return await response.arrayBuffer();
    }
}

export class NativeHttpClient implements HttpClient {
    /// The logger
    logger: Logger;
    /// The endpoint
    endpoint: NativeHttpProxyConfig;

    /// Constructor
    constructor(proxy: NativeHttpProxyConfig, logger: Logger) {
        this.logger = logger;
        this.endpoint = proxy;
    }

    public async fetch(input: URL, init?: RequestInit): Promise<HttpFetchResult> {
        const url = new URL(this.endpoint.proxyEndpoint);
        url.pathname = `/http/streams`;

        const headers = new Headers(init?.headers);
        headers.set(HEADER_NAME_ENDPOINT, input.host);
        headers.set(HEADER_NAME_PATH, input.pathname);
        headers.set(HEADER_NAME_BATCH_TIMEOUT, "1000");
        headers.set(HEADER_NAME_READ_TIMEOUT, "1000");

        const request = new Request(url, {
            method: 'POST',
            headers,
            body: init?.body
        });
        const response = await fetch(request);

        // Parse the stream id
        let streamId: number | null = null;
        if (response.status == 200) {
            const streamIdText = response.headers.get(HEADER_NAME_STREAM_ID);
            if (streamIdText == null) {
                this.logger.error("fetch returned with status 200 but did not include a stream id", "native_http_client");
                throw new Error("missing stream id");
            }
            streamId = Number.parseInt(streamIdText);
        }

        // Return a native http server stream
        return new NativeHttpServerStream(this.endpoint, streamId, response.headers, response.status, response.statusText, this.logger);;
    }
}

