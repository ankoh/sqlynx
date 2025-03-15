import * as proto from "@ankoh/dashql-protobuf";

import { NativeGrpcServerStreamBatchEvent } from "./native_grpc_client.js";
import { NativeHttpServerStreamBatchEvent } from "./native_http_client.js";
import { PlatformType } from "./platform_type.js";

/// Only process requests that are targeting dashql-native://
const NATIVE_API_SCHEME = "dashql-native://";

export const HEADER_NAME_CHANNEL_ID = "dashql-channel-id";
export const HEADER_NAME_STREAM_ID = "dashql-stream-id";
export const HEADER_NAME_BATCH_BYTES = "dashql-batch-bytes";
export const HEADER_NAME_BATCH_EVENT = "dashql-batch-event";
export const HEADER_NAME_BATCH_MESSAGES = "dashql-batch-messages";
export const HEADER_NAME_READ_TIMEOUT = "dashql-read-timeout";
export const HEADER_NAME_BATCH_TIMEOUT = "dashql-batch-timeout";

export const HEADER_NAME_METHOD = "dashql-method";
export const HEADER_NAME_ENDPOINT = "dashql-endpoint";
export const HEADER_NAME_PATH = "dashql-path";
export const HEADER_NAME_SEARCH_PARAMS = "dashql-search-params";
export const HEADER_NAME_TLS = "dashql-tls";
export const HEADER_NAME_TLS_CLIENT_KEY = "dashql-tls-client-key";
export const HEADER_NAME_TLS_CLIENT_CERT = "dashql-tls-client-cert";
export const HEADER_NAME_TLS_CACERTS = "dashql-tls-cacerts";

interface RouteMatchers {
    httpStreams: RegExp;
    httpStream: RegExp;
    grpcChannels: RegExp;
    grpcChannel: RegExp;
    grpcChannelStreams: RegExp;
    grpcChannelStream: RegExp;
}

export interface HttpServerStreamBatch {
    event: NativeHttpServerStreamBatchEvent;
    chunks: Uint8Array[],
    trailers?: Headers
}

export class HttpServerStream {
    streamId: number | null;
    status: number;
    statusMessage: string;
    metadata: Record<string, string>;
    batches: HttpServerStreamBatch[];
    nextBatchId: number;

    constructor(status: number, statusMessage: string, metadata: Record<string, string>, events: HttpServerStreamBatch[]) {
        this.streamId = null;
        this.status = status;
        this.statusMessage = statusMessage;
        this.metadata = metadata;
        this.batches = events;
        this.nextBatchId = 0;
    }

    public reachedEnd(): boolean {
        return this.nextBatchId == this.batches.length;
    }

    public read(): Response {
        const batchId = this.nextBatchId;
        this.nextBatchId += 1;

        if (batchId < this.batches.length) {
            const batch = this.batches[batchId];

            // Encode all messages in the batch
            let totalBatchBytes = 0;
            for (const m of batch.chunks) {
                totalBatchBytes += m.byteLength;
            }

            // Combine all message bytes into a single body buffer
            const bodyBuffer = new ArrayBuffer(totalBatchBytes);
            let bodyWriteOffset = 0;
            for (const m of batch.chunks) {
                new Uint8Array(bodyBuffer, bodyWriteOffset, m.byteLength).set(m);
                bodyWriteOffset += m.byteLength;
            }
            return new Response(bodyBuffer, {
                status: 200,
                statusText: "OK",
                headers: {
                    [HEADER_NAME_STREAM_ID]: this.streamId!.toString(),
                    [HEADER_NAME_BATCH_EVENT]: batch.event,
                    [HEADER_NAME_BATCH_BYTES]: totalBatchBytes.toString()
                }
            });
        } else {
            return new Response(JSON.stringify({ message: "unknown stream" }), {
                status: 404,
                headers: new Headers({
                    "dashql-error": "true",
                    "content-type": "application/json"
                })
            });
        }
    }
}

interface HttpServerMock {
    processRequest: ((req: Request) => HttpServerStream) | null;
}

export interface GrpcServerStreamBatch {
    event: NativeGrpcServerStreamBatchEvent;
    messages: any[],
    trailers?: Headers
}

export class GrpcServerStream {
    channelId: number | null;
    streamId: number | null;
    initialStatus: number;
    initialStatusMessage: string;
    initialMetadata: Record<string, string>;
    batches: GrpcServerStreamBatch[]; // XXX Make this an async generator for GrpcServerStreamBatches
    nextBatchId: number;

    constructor(initialStatus: number, initialStatusMessage: string, initialMetadata: Record<string, string>, events: GrpcServerStreamBatch[]) {
        this.channelId = null;
        this.streamId = null;
        this.initialStatus = initialStatus;
        this.initialStatusMessage = initialStatusMessage;
        this.initialMetadata = initialMetadata;
        this.batches = events;
        this.nextBatchId = 0;
    }

    public reachedEnd(): boolean {
        return this.nextBatchId == this.batches.length;
    }

    public read(): Response {
        const batchId = this.nextBatchId;
        this.nextBatchId += 1;

        if (batchId < this.batches.length) {
            const batch = this.batches[batchId];

            // Encode all messages in the batch
            const encodedMessages = batch.messages.map((m) => m.toBinary());
            let totalBatchBytes = 0;
            for (const m of encodedMessages) {
                totalBatchBytes += m.length;
            }

            // Combine all message bytes into a single body buffer
            const bodyBuffer = new ArrayBuffer(totalBatchBytes + 4 * encodedMessages.length);
            const bodyView = new DataView(bodyBuffer);
            let bodyWriteOffset = 0;
            for (const m of encodedMessages) {
                bodyView.setUint32(bodyWriteOffset, m.byteLength, true);
                bodyWriteOffset += 4;
                new Uint8Array(bodyBuffer, bodyWriteOffset, m.byteLength).set(m);
                bodyWriteOffset += m.byteLength;
            }
            return new Response(bodyBuffer, {
                status: 200,
                headers: {
                    [HEADER_NAME_CHANNEL_ID]: this.channelId!.toString(),
                    [HEADER_NAME_STREAM_ID]: this.streamId!.toString(),
                    [HEADER_NAME_BATCH_EVENT]: batch.event,
                    [HEADER_NAME_BATCH_MESSAGES]: batch.messages.length.toString(),
                    [HEADER_NAME_BATCH_BYTES]: totalBatchBytes.toString()
                }
            });
        } else {
            return new Response(JSON.stringify({ message: "unknown stream" }), {
                status: 404,
                headers: new Headers({
                    "dashql-error": "true",
                    "content-type": "application/json"
                })
            });
        }
    }
}

class GrpcChannel {
    channelId: number;
    streams: Map<number, GrpcServerStream>;

    constructor(channelId: number) {
        this.channelId = channelId;
        this.streams = new Map();
    }
};

interface HyperServiceMock {
    executeQuery: ((req: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam) => GrpcServerStream) | null;
}

/// The native API mock mimics the api that is provided by tauri.
export class NativeAPIMock {
    /// The platform type
    platform: PlatformType;
    /// The route matchers
    routeMatchers: RouteMatchers;
    /// The next http stream id
    nextHttpStreamId: number;
    /// The grpc channels
    httpStreams: Map<number, HttpServerStream>;
    /// The next gRPC channel id
    nextGrpcChannelId: number;
    /// The next gRPC stream id
    nextGrpcStreamId: number;
    /// The grpc channels
    grpcChannels: Map<number, GrpcChannel>;
    /// The hyper service
    hyperService: HyperServiceMock;
    /// The http service
    httpServer: HttpServerMock;

    /// The constructor
    constructor(platform: PlatformType) {
        this.platform = platform;
        this.routeMatchers = {
            httpStreams: /^\/http\/streams$/,
            httpStream: /^\/http\/stream\/(?<stream>\d+)$/,
            grpcChannels: /^\/grpc\/channels$/,
            grpcChannel: /^\/grpc\/channel\/(?<channel>\d+)$/,
            grpcChannelStreams: /^\/grpc\/channel\/(?<channel>\d+)\/streams$/,
            grpcChannelStream: /^\/grpc\/channel\/(?<channel>\d+)\/stream\/(?<stream>\d+)$/,
        };
        this.nextHttpStreamId = 1;
        this.httpStreams = new Map();
        this.nextGrpcChannelId = 1;
        this.nextGrpcStreamId = 1;
        this.grpcChannels = new Map();
        this.hyperService = {
            executeQuery: null
        };
        this.httpServer = {
            processRequest: null
        }
    }

    /// Create a http stream
    protected async startHttpServerStream(req: Request): Promise<Response> {
        const handler = this.httpServer.processRequest;
        if (handler == null) {
            return new Response(JSON.stringify({ message: "unexpected http call" }), {
                status: 400,
                headers: new Headers({
                    "dashql-error": "true",
                    "content-type": "application/json"
                })
            });
        }
        const stream = handler(req);
        const streamId = this.nextHttpStreamId;
        stream.streamId = streamId;
        this.nextHttpStreamId += 1;
        this.httpStreams.set(streamId, stream);

        return new Response(null, {
            status: 200,
            headers: {
                [HEADER_NAME_STREAM_ID]: streamId.toString()
            }
        });
    }

    /// Read from a http stream
    protected async readFromHttpStream(stream: HttpServerStream, _req: Request): Promise<Response> {
        const response = stream.read();
        if (stream.reachedEnd()) {
            this.httpStreams.delete(stream.streamId!);
        }
        return response;
    }

    /// Create a gRPC channel
    protected async createGrpcChannel(_req: Request): Promise<Response> {
        const channelId = this.nextGrpcStreamId;
        const channel = new GrpcChannel(channelId);
        this.grpcChannels.set(channelId, channel);
        this.nextGrpcChannelId += 1;

        return new Response(null, {
            status: 200,
            headers: {
                [HEADER_NAME_CHANNEL_ID]: channelId.toString()
            }
        });
    }
    /// Delete a gRPC channel
    protected async deleteGrpcChannel(channelId: number, _req: Request): Promise<Response> {
        this.grpcChannels.delete(channelId);
        return new Response(null, {
            status: 200,
            headers: {}
        });
    }

    /// Call a streaming gRPC
    protected async streamingGrpcCall(channel: GrpcChannel, req: Request): Promise<Response> {
        const path = req.headers.get(HEADER_NAME_PATH);
        switch (path) {
            case "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery": {
                const handler = this.hyperService.executeQuery;
                if (handler == null) {
                    return new Response(JSON.stringify({ message: "unexpected gRPC call", details: "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery" }), {
                        status: 400,
                        headers: new Headers({
                            "dashql-error": "true",
                            "content-type": "application/json"
                        })
                    });
                }
                const body = await req.arrayBuffer();
                const params = proto.salesforce_hyperdb_grpc_v1.pb.QueryParam.fromBinary(new Uint8Array(body));
                const stream = handler(params);
                stream.channelId = channel.channelId;
                stream.streamId = this.nextGrpcStreamId;
                this.nextGrpcStreamId += 1;
                channel.streams.set(stream.streamId, stream);
                return new Response(null, {
                    status: stream.initialStatus,
                    statusText: stream.initialStatusMessage,
                    headers: {
                        ...stream.initialMetadata,
                        [HEADER_NAME_CHANNEL_ID]: stream.channelId.toString(),
                        [HEADER_NAME_STREAM_ID]: stream.streamId.toString()
                    }
                });
            }
            default:
                return new Response(JSON.stringify({ message: `invalid gRPC streaming path`, details: path }), {
                    status: 400,
                    headers: new Headers({
                        "dashql-error": "true",
                        "content-type": "application/json"
                    })
                });
        }
    }

    /// Read from a gRPC stream
    protected async readFromGrpcStream(channel: GrpcChannel, stream: GrpcServerStream, _req: Request): Promise<Response> {
        const response = stream.read();
        if (stream.reachedEnd()) {
            channel.streams.delete(stream.streamId!);
        }
        return response;
    }

    /// Process a fetch request.
    /// This mock will reject any request that are not targeting the native api.
    public async process(req: Request): Promise<Response> {
        // Reject any requests that are not targeting native
        if (!req.url.startsWith(NATIVE_API_SCHEME)) {
            return new Response(JSON.stringify({ message: `scheme is not matching`, details: NATIVE_API_SCHEME }), {
                status: 400,
                headers: new Headers({
                    "dashql-error": "true",
                    "content-type": "application/json"
                })
            });
        }
        // If the request targets /, we consider this a health check and return with 200
        const url = new URL(req.url);
        if (url.pathname == "/") {
            return new Response(null, {
                status: 200,
                statusText: "OK",
                headers: {}
            });
        }

        // Helper to report an invalid request
        const invalidRequest = (req: Request) => new Response(JSON.stringify({ message: `invalid request`, details: `path=${new URL(req.url).pathname} method=${req.method}` }), {
            status: 400,
            headers: new Headers({
                "dashql-error": "true",
                "content-type": "application/json"
            })
        });

        // Create a gRPC channel
        let matches: RegExpExecArray | null = null;
        if ((matches = this.routeMatchers.grpcChannels.exec(url.pathname)) !== null) {
            switch (req.method) {
                case "POST": return this.createGrpcChannel(req);
                default:
                    return invalidRequest(req);
            }
        }
        // Delete a gRPC channel
        if ((matches = this.routeMatchers.grpcChannel.exec(url.pathname)) !== null) {
            const channelId = Number.parseInt(matches.groups!["channel"]!);
            switch (req.method) {
                case "DELETE": return this.deleteGrpcChannel(channelId, req);
                default:
                    return invalidRequest(req);
            }
        }
        // Create a gRPC server stream
        if ((matches = this.routeMatchers.grpcChannelStreams.exec(url.pathname)) !== null) {
            const channelId = Number.parseInt(matches.groups!["channel"]!);
            const channel = this.grpcChannels.get(channelId);
            if (!channel) {
                return new Response(JSON.stringify({ message: `channel not found` }), {
                    status: 404,
                    headers: new Headers({
                        "dashql-error": "true",
                        "content-type": "application/json"
                    })
                });
            }
            switch (req.method) {
                case "POST": return this.streamingGrpcCall(channel, req);
                default:
                    return invalidRequest(req);
            }
        }
        // Read from a gRPC server stream
        if ((matches = this.routeMatchers.grpcChannelStream.exec(url.pathname)) !== null) {
            const channelId = Number.parseInt(matches.groups!["channel"]!);
            const streamId = Number.parseInt(matches.groups!["stream"]!);
            const channel = this.grpcChannels.get(channelId);
            if (!channel) {
                return new Response(JSON.stringify({ message: `channel not found` }), {
                    status: 404,
                    headers: new Headers({
                        "dashql-error": "true",
                        "content-type": "application/json"
                    })
                });
            }
            const stream = channel.streams.get(streamId);
            if (!stream) {
                return new Response(JSON.stringify({ message: `stream not found` }), {
                    status: 404,
                    headers: new Headers({
                        "dashql-error": "true",
                        "content-type": "application/json"
                    })
                });
            }
            switch (req.method) {
                case "GET": return this.readFromGrpcStream(channel, stream, req);
                default:
                    return invalidRequest(req);
            }
        }
        // Create a HTTP server stream
        if ((matches = this.routeMatchers.httpStreams.exec(url.pathname)) !== null) {
            return this.startHttpServerStream(req);
        }
        // Read from a HTTP server stream
        if ((matches = this.routeMatchers.httpStream.exec(url.pathname)) !== null) {
            const streamId = Number.parseInt(matches.groups!["stream"]!);
            const stream = this.httpStreams.get(streamId);
            if (!stream) {
                return new Response(JSON.stringify({ message: `stream not found` }), {
                    status: 404,
                    headers: new Headers({
                        "dashql-error": "true",
                        "content-type": "application/json"
                    })
                });
            }
            switch (req.method) {
                case "GET": return this.readFromHttpStream(stream, req);
                case "DELETE": return this.readFromHttpStream(stream, req);
                default:
                    return invalidRequest(req);
            }
        }
        return invalidRequest(req);
    }
}
