import * as proto from "@ankoh/hyperdb-proto";

import { PlatformType } from "./platform_api.js";

/// Only process requests that are targeting sqlynx-native://
const NATIVE_API_SCHEME = "sqlynx-native://";

// const HEADER_PREFIX = "sqlynx-";
// const HEADER_NAME_HOST = "sqlynx-host";
// const HEADER_NAME_TLS_CLIENT_KEY = "sqlynx-tls-client-key";
// const HEADER_NAME_TLS_CLIENT_CERT = "sqlynx-tls-client-cert";
// const HEADER_NAME_TLS_CACERTS = "sqlynx-tls-cacerts";
export const HEADER_NAME_PATH = "sqlynx-path";
export const HEADER_NAME_CHANNEL_ID = "sqlynx-channel-id";
export const HEADER_NAME_STREAM_ID = "sqlynx-stream-id";
// const HEADER_NAME_READ_TIMEOUT = "sqlynx-read-timeout";
// const HEADER_NAME_BATCH_TIMEOUT = "sqlynx-batch-timout";
// const HEADER_NAME_BATCH_BYTES = "sqlynx-batch-bytes";
// const HEADER_NAME_BATCH_EVENT = "sqlynx-batch-event";
// const HEADER_NAME_BATCH_MESSAGES = "sqlynx-batch-messages";

interface RouteMatchers {
    grpcChannels: RegExp;
    grpcChannel: RegExp;
    grpcChannelStreams: RegExp;
    grpcChannelStream: RegExp;
}

interface GrpcChannel { };

type GrpcServerStreamEvent<T> = { status: "ok", message: T[] };

class GrpcServerStream<T> {
    initialStatus: number;
    initialStatusMessage: string;
    initialMetadata: Record<string, string>;
    events: GrpcServerStreamEvent<T>[];
    constructor(initialStatus: number, initialStatusMessage: string, initialMetadata: Record<string, string>, events: GrpcServerStreamEvent<T>[]) {
        this.initialStatus = initialStatus;
        this.initialStatusMessage = initialStatusMessage;
        this.initialMetadata = initialMetadata;
        this.events = events;
    }
}

interface HyperServiceMock {
    executeQuery: ((req: proto.pb.QueryParam) => GrpcServerStream<proto.pb.QueryResult>) | null;
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
        const channel: GrpcChannel = {};
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
    protected async streamingGrpcCall(_channelId: number, req: Request): Promise<Response> {
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
                const params = proto.pb.QueryParam.fromBinary(new Uint8Array(body));
                const result = handler(params);
                const streamId = this.nextGrpcStreamId;
                this.nextGrpcStreamId += 1;
                return new Response(null, {
                    status: result.initialStatus,
                    statusText: result.initialStatusMessage,
                    headers: {
                        ...result.initialMetadata,
                        [HEADER_NAME_STREAM_ID]: streamId.toString()
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
            switch (req.method) {
                case "POST": return this.streamingGrpcCall(channelId, req);
                default:
                    return invalidRequest(req);
            }
        }
        return invalidRequest(req);
    }
}
