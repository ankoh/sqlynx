import { DetailedError } from '../utils/error.js';
import { RawProxyError } from './channel_common.js';
import { HttpClient, HttpFetchResult } from './http_client.js';
import { Logger } from './logger.js';
import { HEADER_NAME_BATCH_BYTES, HEADER_NAME_BATCH_EVENT, HEADER_NAME_BATCH_TIMEOUT, HEADER_NAME_ENDPOINT, HEADER_NAME_METHOD, HEADER_NAME_PATH, HEADER_NAME_READ_TIMEOUT, HEADER_NAME_SEARCH_PARAMS, HEADER_NAME_STREAM_ID } from "./native_api_mock.js";

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

export class NativeHttpError extends Error implements DetailedError {
    /// The detail
    details: Record<string, string>;

    constructor(o: RawProxyError) {
        super(o.message);
        this.details = o.details ?? {};
    }
}

async function throwIfError(response: Response): Promise<void> {
    if (response.headers.get("sqlynx-error") ?? false) {
        const proxyError = await response.json() as RawProxyError;
        throw new NativeHttpError(proxyError);
    } else if (response.status != 200) {
        throw new NativeHttpError({ message: response.statusText });
    }
}

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
    /// The native http error (if any)
    initialErrorBody: RawProxyError | null;
    /// The logger
    logger: Logger;
    /// The text decoder for decoding utf8
    textDecoder: TextDecoder;

    /// Constructor
    constructor(endpoint: NativeHttpProxyConfig, streamId: number | null, headers: Headers, status: number, statusText: string, initialErrorBody: RawProxyError | null, logger: Logger) {
        this.headers = headers;
        this.status = status;
        this.statusText = statusText;
        this.initialErrorBody = initialErrorBody;
        this.endpoint = endpoint;
        this.streamId = streamId;
        this.logger = logger;
        this.textDecoder = new TextDecoder();
    }

    async json(): Promise<any> {
        if (this.initialErrorBody != null) {
            return this.initialErrorBody;
        }
        const buffer = await this.arrayBuffer();
        const text = this.textDecoder.decode(buffer);
        if (text == "") {
            this.logger.debug(`response body is empty`, {});
            return {};
        } else {
            return JSON.parse(text);
        }
    }

    /// Get the response as array buffer
    async arrayBuffer(): Promise<ArrayBuffer> {
        if (this.streamId == null) {
            return new ArrayBuffer(0);
        }

        // Prepare request
        const url = new URL(this.endpoint.proxyEndpoint);
        url.pathname = `/http/stream/${this.streamId}`;
        const headers = new Headers();
        headers.set(HEADER_NAME_BATCH_BYTES, "4000000"); // 4 MB
        headers.set(HEADER_NAME_BATCH_TIMEOUT, "1000");
        headers.set(HEADER_NAME_READ_TIMEOUT, "10000");

        const chunks = [];
        let totalChunkBytes = 0;

        // Fetch all the chunks
        let fetchNext = true;
        while (fetchNext) {
            const request = new Request(url, {
                method: 'GET',
                headers,
            });
            const response = await fetch(request);
            await throwIfError(response);

            // Get batch event
            const batchEvent = response.headers.get(HEADER_NAME_BATCH_EVENT);
            this.logger.debug("received fetch response", { "event": batchEvent }, "native_http_client")
            switch (batchEvent) {
                case "StreamFailed":
                    fetchNext = false;
                    break;
                case "StreamFinished":
                case "FlushAfterClose":
                    fetchNext = false;
                    break;
                case "FlushAfterTimeout":
                case "FlushAfterBytes":
                    break;
            }
            const buffer = await response.arrayBuffer();
            chunks.push(buffer)
            totalChunkBytes += buffer.byteLength;
        }


        // Combine buffers
        const combined = new Uint8Array(new ArrayBuffer(totalChunkBytes));
        let combinedWriter = 0;
        for (const chunk of chunks) {
            combined.set(new Uint8Array(chunk), combinedWriter);
            combinedWriter += chunk.byteLength;
        }

        return combined.buffer;
    }
}

export class NativeHttpClient implements HttpClient {
    /// The logger
    logger: Logger;
    /// The endpoint
    endpoint: NativeHttpProxyConfig;
    /// The text encoder
    encoder: TextEncoder;

    /// Constructor
    constructor(proxy: NativeHttpProxyConfig, logger: Logger) {
        this.logger = logger;
        this.endpoint = proxy;
        this.encoder = new TextEncoder();
    }

    public async fetch(input: URL, init?: RequestInit): Promise<HttpFetchResult> {
        const url = new URL(this.endpoint.proxyEndpoint);
        url.pathname = `/http/streams`;
        const remote = `${input.protocol}//${input.host}`;
        input.search

        const headers = new Headers(init?.headers);
        headers.set(HEADER_NAME_METHOD, init?.method ?? "GET");
        headers.set(HEADER_NAME_ENDPOINT, remote);
        headers.set(HEADER_NAME_PATH, input.pathname);
        headers.set(HEADER_NAME_SEARCH_PARAMS, input.searchParams.toString());
        headers.set(HEADER_NAME_BATCH_TIMEOUT, "1000");
        headers.set(HEADER_NAME_READ_TIMEOUT, "10000");

        this.logger.debug(`fetch http stream`, { "remote": remote, "path": input?.toString() }, "native_http_client");

        const body: any = init?.body;
        let bodyBuffer: ArrayBuffer;
        if (init?.body) {
            if (init.body instanceof ArrayBuffer) {
                bodyBuffer = init.body;
            } else if (init.body instanceof URLSearchParams) {
                bodyBuffer = new TextEncoder().encode(body.toString());
            } else if (typeof init.body == "string") {
                bodyBuffer = new TextEncoder().encode(body);
            } else {
                throw Error("fetch body is of unexpected type");
            }
        }

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
                this.logger.error("fetch returned with status 200 but did not include a stream id", {}, "native_http_client");
                throw new Error("missing stream id");
            }
            streamId = Number.parseInt(streamIdText);

            return new NativeHttpServerStream(this.endpoint, streamId, response.headers, response.status, response.statusText, null, this.logger);;
        } else {
            let rawProxyError: any | null = null;
            if (response.headers.get("sqlynx-error") ?? false) {
                rawProxyError = await response.json() as RawProxyError;
            }
            return new NativeHttpServerStream(this.endpoint, streamId, response.headers, response.status, response.statusText, rawProxyError, this.logger);;
        }
    }
}

