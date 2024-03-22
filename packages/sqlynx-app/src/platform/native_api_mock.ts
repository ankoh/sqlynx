import * as proto from "@ankoh/sqlynx-pb";

import { PlatformType } from "./platform_api.js";
import { Message } from "@bufbuild/protobuf";
import { NativeGrpcServerStreamBatchEvent } from "./native_grpc_client.js";

/// Only process requests that are targeting sqlynx-native://
const NATIVE_API_SCHEME = "sqlynx-native://";

export const HEADER_NAME_CHANNEL_ID = "sqlynx-channel-id";
export const HEADER_NAME_STREAM_ID = "sqlynx-stream-id";
export const HEADER_NAME_BATCH_BYTES = "sqlynx-batch-bytes";
export const HEADER_NAME_BATCH_EVENT = "sqlynx-batch-event";
export const HEADER_NAME_BATCH_MESSAGES = "sqlynx-batch-messages";
export const HEADER_NAME_READ_TIMEOUT = "sqlynx-read-timeout";
export const HEADER_NAME_BATCH_TIMEOUT = "sqlynx-batch-timeout";

export const HEADER_NAME_ENDPOINT = "sqlynx-endpoint";
export const HEADER_NAME_PATH = "sqlynx-path";
export const HEADER_NAME_TLS_CLIENT_KEY = "sqlynx-tls-client-key";
export const HEADER_NAME_TLS_CLIENT_CERT = "sqlynx-tls-client-cert";
export const HEADER_NAME_TLS_CACERTS = "sqlynx-tls-cacerts";

interface RouteMatchers {
    grpcChannels: RegExp;
    grpcChannel: RegExp;
    grpcChannelStreams: RegExp;
    grpcChannelStream: RegExp;
}

export interface GrpcServerStreamBatch {
    event: NativeGrpcServerStreamBatchEvent;
    messages: Message[],
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
            let bodyBuffer = new ArrayBuffer(totalBatchBytes + 4 * encodedMessages.length);
            let bodyView = new DataView(bodyBuffer);
            let bodyWriteOffset = 0;
            for (const m of encodedMessages) {
                bodyView.setUint32(bodyWriteOffset, m.byteLength, true);
                bodyWriteOffset += 4;
                new Uint8Array(bodyBuffer, bodyWriteOffset, m.byteLength).set(m);
                bodyWriteOffset += m.byteLength;
            }
            return new Response(bodyBuffer, {
                status: 200,
                statusText: "OK",
                headers: {
                    [HEADER_NAME_CHANNEL_ID]: this.channelId!.toString(),
                    [HEADER_NAME_STREAM_ID]: this.streamId!.toString(),
                    [HEADER_NAME_BATCH_EVENT]: batch.event,
                    [HEADER_NAME_BATCH_MESSAGES]: batch.messages.length.toString(),
                    [HEADER_NAME_BATCH_BYTES]: totalBatchBytes.toString()
                }
            });
        } else {
            return new Response(null, {
                status: 404,
                statusText: "unknown stream"
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

type ExecuteQueryMockFn = ((req: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam) => GrpcServerStream);

interface HyperServiceMock {
    executeQuery: ((req: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam) => GrpcServerStream) | null;
}

/// The native API mock mimics the api that is provided by tauri.
export class NativeAPIMock {
    /// The platform type
    platform: PlatformType;
    /// The route matchers
    routeMatchers: RouteMatchers;
    /// The next gRPC channel id
    nextGrpcChannelId: number;
    /// The next gRPC stream id
    nextGrpcStreamId: number;
    /// The grpc channels
    grpcChannels: Map<number, GrpcChannel>;
    /// The hyper service
    hyperService: HyperServiceMock;


    /// The constructor
    constructor(platform: PlatformType) {
        this.platform = platform;
        this.routeMatchers = {
            grpcChannels: /^\/grpc\/channels$/,
            grpcChannel: /^\/grpc\/channel\/(?<channel>\d+)$/,
            grpcChannelStreams: /^\/grpc\/channel\/(?<channel>\d+)\/streams$/,
            grpcChannelStream: /^\/grpc\/channel\/(?<channel>\d+)\/stream\/(?<stream>\d+)$/,
        };
        this.nextGrpcChannelId = 1;
        this.nextGrpcStreamId = 1;
        this.grpcChannels = new Map();
        this.hyperService = {
            executeQuery: null
        };
    }

    /// Create a gRPC channel
    protected async createGrpcChannel(_req: Request): Promise<Response> {
        const channelId = this.nextGrpcStreamId;
        const channel = new GrpcChannel(channelId);
        this.grpcChannels.set(channelId, channel);
        this.nextGrpcChannelId += 1;

        return new Response(null, {
            status: 200,
            statusText: "OK",
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
            statusText: "OK",
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
                    return new Response(null, {
                        status: 400,
                        statusText: "unexpected gRPC call of: /salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery",
                        headers: {}
                    })
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
                return new Response(null, {
                    status: 400,
                    statusText: `invalid gRPC streaming path: ${path}`,
                    headers: {}
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
            return new Response(null, {
                status: 400,
                statusText: `scheme is not matching ${NATIVE_API_SCHEME}`,
                headers: {}
            });
        }
        // If the request targets /, we consider this a health check and return with 200
        let url = new URL(req.url);
        if (url.pathname == "/") {
            return new Response(null, {
                status: 200,
                statusText: "OK",
                headers: {}
            });
        }

        // Helper to report an invalid request
        const invalidRequest = (req: Request) => new Response(null, {
            status: 400,
            statusText: `invalid request: path=${new URL(req.url).pathname} method=${req.method}`,
            headers: {}
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
        // Create a server stream
        if ((matches = this.routeMatchers.grpcChannelStreams.exec(url.pathname)) !== null) {
            const channelId = Number.parseInt(matches.groups!["channel"]!);
            const channel = this.grpcChannels.get(channelId);
            if (!channel) {
                return new Response(null, {
                    status: 404,
                    statusText: `channel not found`
                });
            }
            switch (req.method) {
                case "POST": return this.streamingGrpcCall(channel, req);
                default:
                    return invalidRequest(req);
            }
        }
        // Read from a server stream
        if ((matches = this.routeMatchers.grpcChannelStream.exec(url.pathname)) !== null) {
            const channelId = Number.parseInt(matches.groups!["channel"]!);
            const streamId = Number.parseInt(matches.groups!["stream"]!);
            const channel = this.grpcChannels.get(channelId);
            if (!channel) {
                return new Response(null, {
                    status: 404,
                    statusText: `channel not found`
                });
            }
            const stream = channel.streams.get(streamId);
            if (!stream) {
                return new Response(null, {
                    status: 404,
                    statusText: `stream not found`
                });
            }
            switch (req.method) {
                case "GET": return this.readFromGrpcStream(channel, stream, req);
                default:
                    return invalidRequest(req);
            }
        }
        return invalidRequest(req);
    }
}
