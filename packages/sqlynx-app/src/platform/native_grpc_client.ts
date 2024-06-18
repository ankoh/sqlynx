import { GrpcChannelArgs, GrpcError, GrpcMetadataProvider } from './grpc_common.js';
import { Logger } from "./logger.js";
import { HEADER_NAME_BATCH_BYTES, HEADER_NAME_BATCH_TIMEOUT, HEADER_NAME_CHANNEL_ID, HEADER_NAME_ENDPOINT, HEADER_NAME_PATH, HEADER_NAME_READ_TIMEOUT, HEADER_NAME_STREAM_ID, HEADER_NAME_TLS_CACERTS, HEADER_NAME_TLS_CLIENT_CERT, HEADER_NAME_TLS_CLIENT_KEY } from "./native_api_mock.js";

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
    metadata?: Record<string, string>;
}

export interface NativeGrpcProxyConfig {
    /// The endpoint URL
    proxyEndpoint: URL;
}

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

export class NativeGrpcServerStream implements AsyncIterator<NativeGrpcServerStreamBatch> {
    /// The logger
    logger: Logger;
    /// The endpoint
    endpoint: NativeGrpcProxyConfig;
    /// The channel id
    channelId: number;
    /// The stream id
    streamId: number;
    /// The metadata provider
    metadataProvider: GrpcMetadataProvider;
    /// Reached the end of the stream?
    reachedEndOfStream: boolean;

    constructor(endpoint: NativeGrpcProxyConfig, channelId: number, streamId: number, metadata: GrpcMetadataProvider, logger: Logger) {
        this.logger = logger;
        this.endpoint = endpoint;
        this.channelId = channelId;
        this.streamId = streamId;
        this.metadataProvider = metadata;
        this.reachedEndOfStream = false;
    }

    /// Read the next messages from the stream
    public async read(): Promise<NativeGrpcServerStreamBatch> {
        const url = new URL(this.endpoint.proxyEndpoint);
        url.pathname = `/grpc/channel/${this.channelId}/stream/${this.streamId}`;
        const requestMetadata = await this.metadataProvider.getRequestMetadata();
        const request = new Request(url, {
            method: 'GET',
            headers: {
                ...requestMetadata,
                [HEADER_NAME_READ_TIMEOUT]: DEFAULT_READ_TIMEOUT.toString(),
                [HEADER_NAME_BATCH_TIMEOUT]: DEFAULT_BATCH_TIMEOUT.toString(),
                [HEADER_NAME_BATCH_BYTES]: DEFAULT_BATCH_BYTES.toString(),
            }
        });
        const response = await fetch(request);

        if (response.status != 200) {
            const grpcStatus = requireIntegerHeader(response.headers, "sqlynx-grpc-status");
            const body = await response.text();
            throw new GrpcError(grpcStatus, body);
        }

        const streamBatchEvent = requireStringHeader(response.headers, "sqlynx-batch-event");
        const streamBatchMessages = requireIntegerHeader(response.headers, "sqlynx-batch-messages");
        const bodyBuffer = await response.arrayBuffer();
        const bodyBufferView = new DataView(bodyBuffer);

        // Unpack the messages
        let offset = 0;
        const messages = [];
        while (offset < bodyBuffer.byteLength) {
            const length = bodyBufferView.getUint32(offset, true);
            offset += 4;
            messages.push(new Uint8Array(bodyBuffer, offset, length));
            offset += length;
        }

        // Message count mismatch?
        // We treat this as an error since this means our encoded response buffer is corrupt.
        if (streamBatchMessages != messages.length) {
            // Fatal error, silently drop the stream
            const url = new URL(this.endpoint.proxyEndpoint);
            url.pathname = `/grpc/channels/${this.channelId}/stream/${this.streamId}`;
            const request = new Request(url, {
                method: 'DELETE'
            });
            await fetch(request);
            // XXX Log if the dropping failed
            throw new GrpcError(13, "batch message count mismatch");
        }

        // Return the batch event and all messages
        const metadata: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            metadata[key] = value;
        });

        // Return the batch event and all messages
        return {
            event: streamBatchEvent as NativeGrpcServerStreamBatchEvent,
            messages: messages,
            metadata
        };
    }

    /// Get the next batch
    public async next(): Promise<IteratorResult<NativeGrpcServerStreamBatch>> {
        if (this.reachedEndOfStream) {
            return { value: undefined, done: true };
        }
        const batch = await this.read();
        switch (batch.event) {
            case NativeGrpcServerStreamBatchEvent.FlushAfterBytes:
            case NativeGrpcServerStreamBatchEvent.FlushAfterTimeout:
                return { value: batch, done: false };

            case NativeGrpcServerStreamBatchEvent.StreamFinished:
            case NativeGrpcServerStreamBatchEvent.FlushAfterClose:
                this.reachedEndOfStream = true;
                return { value: batch, done: false };

            case NativeGrpcServerStreamBatchEvent.StreamFailed:
                this.reachedEndOfStream = true;
                throw new GrpcError(400, "", batch.metadata);
        }
    }
}

export class NativeGrpcServerStreamMessageIterator implements AsyncIterator<Uint8Array> {
    /// The logger
    protected logger: Logger;
    /// The batch iterator
    protected batchIterator: AsyncIterator<NativeGrpcServerStreamBatch>;
    /// The current batch
    protected currentBatch: NativeGrpcServerStreamBatch | null;
    /// The next index in the current batch
    protected nextInCurrentBatch: number;

    constructor(batchIterator: AsyncIterator<NativeGrpcServerStreamBatch>, logger: Logger) {
        this.logger = logger;
        this.batchIterator = batchIterator;
        this.currentBatch = null;
        this.nextInCurrentBatch = 0;
    }

    /// Get the bytes from the next message in the gRPC stream
    async next(): Promise<IteratorResult<Uint8Array>> {
        while (true) {
            // Fast path, we still have a buffered message
            if (this.currentBatch !== null && this.nextInCurrentBatch < this.currentBatch.messages.length) {
                const mId = this.nextInCurrentBatch;
                this.nextInCurrentBatch += 1;
                return { value: this.currentBatch.messages[mId], done: false };
            }
            this.currentBatch = null;
            this.nextInCurrentBatch = 0;

            // Otherwise, get a new batch
            const result = await this.batchIterator.next();
            if (result.done) {
                return { value: undefined, done: true, }
            } else {
                this.currentBatch = result.value;
                this.nextInCurrentBatch = 0;
            }
        }
    }
}

interface StartServerStreamArgs {
    /// The path
    path: string;
    /// The request body
    body: Uint8Array;
}

export class NativeGrpcChannel {
    /// The logger
    logger: Logger;
    /// The endpoint
    endpoint: NativeGrpcProxyConfig;
    /// The metadata provider
    metadataProvider: GrpcMetadataProvider;
    /// The channel id
    channelId: number;

    constructor(endpoint: NativeGrpcProxyConfig, channelId: number, metadataProvider: GrpcMetadataProvider, logger: Logger) {
        this.logger = logger;
        this.endpoint = endpoint;
        this.metadataProvider = metadataProvider;
        this.channelId = channelId;
    }

    /// Call a server streaming.
    public async startServerStream(args: StartServerStreamArgs): Promise<NativeGrpcServerStream> {
        const url = new URL(this.endpoint.proxyEndpoint);
        url.pathname = `/grpc/channel/${this.channelId}/streams`;

        // Resolve the additional metadata
        const additionalMetadata = await this.metadataProvider.getRequestMetadata();

        // Collect the request headers
        const headers = new Headers(additionalMetadata);
        headers.set(HEADER_NAME_CHANNEL_ID, this.channelId.toString());
        headers.set(HEADER_NAME_PATH, args.path);

        // Send the request
        const request = new Request(url, {
            method: 'POST',
            headers,
            body: args.body,
        });
        const response = await fetch(request);
        if (response.status != 200) {
            const grpcStatus = requireIntegerHeader(response.headers, "sqlynx-grpc-status");
            const body = await response.text();
            throw new GrpcError(grpcStatus, body);
        }

        const streamId = requireIntegerHeader(response.headers, HEADER_NAME_STREAM_ID);
        return new NativeGrpcServerStream(this.endpoint, this.channelId, streamId, this.metadataProvider, this.logger);
    }

    // Destroy a channel
    public async close(): Promise<void> {
        const url = new URL(this.endpoint.proxyEndpoint);
        url.pathname = `/grpc/channel/${this.channelId}`;

        const headers = new Headers();
        headers.set(HEADER_NAME_CHANNEL_ID, this.channelId.toString());

        // Send the request
        const request = new Request(url, {
            method: 'DELETE',
            headers,
            body: "",
        });
        const response = await fetch(request);
        if (response.status != 200) {
            const grpcStatus = requireIntegerHeader(response.headers, "sqlynx-grpc-status");
            const body = await response.text();
            throw new GrpcError(grpcStatus, body);
        }
    }
}

export class NativeGrpcClient {
    /// The logger
    logger: Logger;
    /// The endpoint
    proxy: NativeGrpcProxyConfig;

    constructor(proxy: NativeGrpcProxyConfig, logger: Logger) {
        this.logger = logger;
        this.proxy = proxy;
    }

    /// Create a gRPC channel
    public async connect(args: GrpcChannelArgs, metadataProvider: GrpcMetadataProvider): Promise<NativeGrpcChannel> {
        const url = new URL(this.proxy.proxyEndpoint);
        url.pathname = `/grpc/channels`;

        // Resolve additional metadata (such as the authorization header)
        const additionalMetadata = await metadataProvider.getRequestMetadata()

        // Set system headers
        const headers = new Headers(additionalMetadata);
        headers.set(HEADER_NAME_ENDPOINT, args.endpoint);
        if (args.tls) {
            if (args.tls.keyPath !== "") {
                headers.set(HEADER_NAME_TLS_CLIENT_KEY, args.tls.keyPath);
            }
            if (args.tls.pubPath !== "") {
                headers.set(HEADER_NAME_TLS_CLIENT_CERT, args.tls.pubPath);
            }
            if (args.tls.caPath !== "") {
                headers.set(HEADER_NAME_TLS_CACERTS, args.tls.caPath);
            }
        }
        const request = new Request(url, {
            method: 'POST',
            headers
        });
        const response = await fetch(request);
        if (response.status !== 200) {
            const grpcStatus = requireIntegerHeader(response.headers, "sqlynx-grpc-status");
            const body = await response.text();
            throw new GrpcError(grpcStatus, body);
        }

        const channelId = requireIntegerHeader(response.headers, HEADER_NAME_CHANNEL_ID);
        return new NativeGrpcChannel(this.proxy, channelId, metadataProvider, this.logger);
    }
}
