import { PlatformType } from "./platform_api.js";

/// Only process requests that are targeting sqlynx-native://
const NATIVE_API_SCHEME = "sqlynx-native://";

// const HEADER_PREFIX = "sqlynx-";
// const HEADER_NAME_HOST = "sqlynx-host";
// const HEADER_NAME_TLS_CLIENT_KEY = "sqlynx-tls-client-key";
// const HEADER_NAME_TLS_CLIENT_CERT = "sqlynx-tls-client-cert";
// const HEADER_NAME_TLS_CACERTS = "sqlynx-tls-cacerts";
// const HEADER_NAME_PATH = "sqlynx-path";
const HEADER_NAME_CHANNEL_ID = "sqlynx-channel-id";
// const HEADER_NAME_STREAM_ID = "sqlynx-stream-id";
// const HEADER_NAME_READ_TIMEOUT = "sqlynx-read-timeout";
// const HEADER_NAME_BATCH_TIMEOUT = "sqlynx-batch-timout";
// const HEADER_NAME_BATCH_BYTES = "sqlynx-batch-bytes";
// const HEADER_NAME_BATCH_EVENT = "sqlynx-batch-event";
// const HEADER_NAME_BATCH_MESSAGES = "sqlynx-batch-messages";

class GRPCChannel {
    id: number;
    constructor(id: number) {
        this.id = id;
    }
};

interface RouteMatchers {
    grpcChannels: RegExp;
    grpcChannel: RegExp;
    grpcChannelUnary: RegExp;
    grpcChannelStreams: RegExp;
    grpcChannelStream: RegExp;
}

/// The native API mock mimics the api that is provided by tauri.
export class NativeAPIMock {
    /// The platform type
    platform: PlatformType;
    /// The route matchers
    routeMatchers: RouteMatchers;

    /// The next gRPC channel id
    nextGrpcChannelId: number;
    /// All grpc Channels
    grpcChannels: Map<number, GRPCChannel>;


    /// The constructor
    constructor(platform: PlatformType) {
        this.platform = platform;
        this.routeMatchers = {
            grpcChannels: /^\/grpc\/channels$/,
            grpcChannel: /^\/grpc\/channel\/(?<channel>\d+)$/,
            grpcChannelUnary: /^\/grpc\/channel\/(?<channel>\d+)\/unary$/,
            grpcChannelStreams: /^\/grpc\/channel\/(?<channel>\d+)\/streams$/,
            grpcChannelStream: /^\/grpc\/channel\/(?<channel>\d+)\/stream\/(?<stream>\d+)$/,
        };
        this.nextGrpcChannelId = 1;
        this.grpcChannels = new Map();
    }

    protected async createGrpcChannel(_req: Request): Promise<Response> {
        const channel = new GRPCChannel(this.nextGrpcChannelId);
        this.grpcChannels.set(channel.id, channel);
        this.nextGrpcChannelId += 1;

        return new Response(null, {
            status: 200,
            statusText: "OK",
            headers: {
                [HEADER_NAME_CHANNEL_ID]: channel.id.toString()
            }
        });
    }
    protected async deleteGrpcChannel(channelId: number, _req: Request): Promise<Response> {
        this.grpcChannels.delete(channelId);
        return new Response(null, {
            status: 200,
            statusText: "OK",
            headers: {}
        });
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

        // Match the individual api routes
        let matches: RegExpExecArray | null = null;
        if ((matches = this.routeMatchers.grpcChannels.exec(url.pathname)) !== null) {
            switch (req.method) {
                case "POST": return this.createGrpcChannel(req);
                default:
                    return invalidRequest(req);
            }
        }
        if ((matches = this.routeMatchers.grpcChannel.exec(url.pathname)) !== null) {
            const channelId = Number.parseInt(matches.groups!["channel"]!);
            switch (req.method) {
                case "DELETE": return this.deleteGrpcChannel(channelId, req);
                default:
                    return invalidRequest(req);
            }
        }


        return invalidRequest(req);
    }
}
