import { HEADER_NAME_BATCH_BYTES, HEADER_NAME_BATCH_TIMEOUT, HEADER_NAME_CHANNEL_ID, HEADER_NAME_PATH, HEADER_NAME_READ_TIMEOUT, HEADER_NAME_STREAM_ID, HEADER_NAME_TLS_CACERTS, HEADER_NAME_TLS_CLIENT_CERT, HEADER_NAME_TLS_CLIENT_KEY } from "./native_api_mock.js";

export enum NativeGrpcServerStreamBatchEvent {
    StreamFailed = "StreamFailed",
    StreamFinished = "StreamFinished",
    FlushAfterClose = "FlushAfterClose",
    FlushAfterTimeout = "FlushAfterTimeout",
    FlushAfterBytes = "FlushAfterBytes",
}

export interface NativeGrpcServerStreamBatch {
    /// The batch event
    event: NativeGrpcServerStreamBatchEvent;
    /// The messages
    messages: Uint8Array[];
    /// The trailers (if any)
    trailers?: Record<string, string>;
}

export interface NativeGrpcEndpoint {
    /// The endpoint URL
    baseURL: URL;
};

const DEFAULT_READ_TIMEOUT = 1000;
const DEFAULT_BATCH_TIMEOUT = 100;
const DEFAULT_BATCH_BYTES = 8000000;

function requireStringHeader(headers: Headers, key: string): string {
    return headers.get(key)!;
}
function requireIntegerHeader(headers: Headers, key: string): number {
    const raw = headers.get(key)!;
    return Number.parseInt(raw);
}

export class NativeGrpcServerStream {
    /// The endpoint
    endpoint: NativeGrpcEndpoint;
    /// The channel id
    channelId: number;
    /// The stream id
    streamId: number;

    constructor(endpoint: NativeGrpcEndpoint, channelId: number, streamId: number) {
        this.endpoint = endpoint;
        this.channelId = channelId;
        this.streamId = streamId;
    }

    /// Read the next messages from the stream
    public async read(): Promise<NativeGrpcServerStreamBatch> {
        const url = new URL(this.endpoint.baseURL);
        url.pathname = `/grpc/channels/${this.channelId}/stream/${this.streamId}`;
        const request = new Request(url, {
            method: 'GET',
            headers: {
                [HEADER_NAME_READ_TIMEOUT]: DEFAULT_READ_TIMEOUT.toString(),
                [HEADER_NAME_BATCH_TIMEOUT]: DEFAULT_BATCH_TIMEOUT.toString(),
                [HEADER_NAME_BATCH_BYTES]: DEFAULT_BATCH_BYTES.toString(),
            }
        });
        const response = await fetch(request);

        if (response.status != 200) {
            throw new NativeGrpcError(response.status, response.statusText);
        }

        const streamBatchEvent = requireStringHeader(response.headers, "sqlynx-batch-event");
        const streamBatchMessages = requireIntegerHeader(response.headers, "sqlynx-batch-messages");
        const bodyBuffer = await response.arrayBuffer();
        const bodyBufferView = new DataView(bodyBuffer);

        // Unpack the messages
        let offset = 0;
        let messages = [];
        while (offset < bodyBuffer.byteLength) {
            const length = bodyBufferView.getUint32(offset, true);
            messages.push(new Uint8Array(bodyBuffer, offset + 4, length));
        }

        // Message count mismatch?
        // We treat this as an error since this means our encoded response buffer is corrupt.
        if (streamBatchMessages != messages.length) {
            // Fatal error, silently drop the stream
            const url = new URL(this.endpoint.baseURL);
            url.pathname = `/grpc/channels/${this.channelId}/stream/${this.streamId}`;
            const request = new Request(url, {
                method: 'DELETE'
            });
            await fetch(request);
            // XXX Log if the dropping failed
            throw new NativeGrpcError(500, "batch message count mismatch");
        }

        // Return the batch event and all messages
        return {
            event: streamBatchEvent as NativeGrpcServerStreamBatchEvent,
            messages: messages,
        };
    }
}

interface StartServerStreamArgs {
    path: string;
    body: Uint8Array;
    tlsClientKeyPath: string | null;
    tlsClientCertPath: string | null;
    tlsCacertsPath: string | null;
}

class NativeGrpcError extends Error {
    status: number;

    constructor(status: number, msg: string) {
        super(msg);
        this.status = status;
        Object.setPrototypeOf(this, NativeGrpcError.prototype);
    }
}

export class NativeGrpcChannel {
    /// The endpoint
    endpoint: NativeGrpcEndpoint;
    /// The channel id
    channelId: number;

    constructor(endpoint: NativeGrpcEndpoint, channelId: number) {
        this.endpoint = endpoint;
        this.channelId = channelId;
    }

    /// Call a server streaming
    public async startServerStream(args: StartServerStreamArgs): Promise<NativeGrpcServerStream> {
        const url = new URL(this.endpoint.baseURL);
        url.pathname = `/grpc/channel/${this.channelId}/streams`;

        // Collect the request headers
        const headers = new Headers();
        headers.set(HEADER_NAME_CHANNEL_ID, this.channelId.toString());
        headers.set(HEADER_NAME_PATH, args.path);
        if (args.tlsClientKeyPath) {
            headers.set(HEADER_NAME_TLS_CLIENT_KEY, args.tlsClientKeyPath);
        }
        if (args.tlsClientCertPath) {
            headers.set(HEADER_NAME_TLS_CLIENT_CERT, args.tlsClientCertPath);
        }
        if (args.tlsCacertsPath) {
            headers.set(HEADER_NAME_TLS_CACERTS, args.tlsCacertsPath);
        }

        // Send the request
        const request = new Request(url, {
            method: 'POST',
            headers,
            body: args.body,
        });
        const response = await fetch(request);
        if (response.status != 200) {
            throw new NativeGrpcError(response.status, response.statusText);
        }

        const streamId = requireIntegerHeader(response.headers, HEADER_NAME_STREAM_ID);
        return new NativeGrpcServerStream(this.endpoint, this.channelId, streamId);
    }
}

export class NativeGrpcClient {
    /// The endpoint
    endpoint: NativeGrpcEndpoint;

    constructor(endpoint: NativeGrpcEndpoint) {
        this.endpoint = endpoint;
    }

    /// Create a gRPC channel
    public async connectChannel(): Promise<NativeGrpcChannel> {
        const url = new URL(this.endpoint.baseURL);
        url.pathname = `/grpc/channels`;

        const request = new Request(url, {
            method: 'POST',
            headers: {}
        });
        const response = await fetch(request);
        if (response.status !== 200) {
            throw new NativeGrpcError(response.status, response.statusText);
        }
        const channelId = requireIntegerHeader(response.headers, HEADER_NAME_CHANNEL_ID);
        return new NativeGrpcChannel(this.endpoint, channelId);
    }
}
