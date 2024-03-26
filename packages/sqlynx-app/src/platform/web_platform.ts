import { PlatformApi, PlatformType } from "./platform_api.js";
import { WebLogger } from './web_logger.js';
import { LogBuffer } from './log_buffer.js';

/// Initialize the web platform
export async function setupWebPlatform(logBuffer: LogBuffer): Promise<PlatformApi | null> {
    // Build the api client
    return {
        /// The platform type
        platformType: PlatformType.WEB,
        /// The web logger
        logger: new WebLogger(logBuffer),
        /// The Hyper Database client is currently not supported in the web.
        /// Data Cloud is not yet exposing a fully functional gRPC-Web endpoint.
        hyperDatabaseClient: null,
    };
};
