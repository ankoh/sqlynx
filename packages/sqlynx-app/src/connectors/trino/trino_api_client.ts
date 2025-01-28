import { HttpClient } from "platform/http_client.js";
import { Logger } from "platform/logger.js";
import { TrinoChannel, TrinoDatabaseConnectionContext } from "./trino_channel.js";
import { ChannelArgs } from "platform/channel_common.js";

export interface TrinoClientInterface {
    /// Create a database connection
    connect(args: ChannelArgs, context: TrinoDatabaseConnectionContext): Promise<TrinoChannel>;
}

export class TrinoClient implements TrinoClientInterface {
    /// The logger
    logger: Logger;
    /// The http client
    httpClient: HttpClient;

    constructor(logger: Logger, httpClient: HttpClient) {
        this.logger = logger;
        this.httpClient = httpClient;
    }

    /// Create a Trino channel
    connect(_args: ChannelArgs, _context: TrinoDatabaseConnectionContext): Promise<TrinoChannel> {
        throw new Error("not implemented");
    }
}
