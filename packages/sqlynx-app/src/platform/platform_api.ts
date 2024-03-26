import { HyperDatabaseClient } from "./platform_hyperdb_client.js";
import { PlatformLogger } from "./platform_logger.js";

export enum PlatformType {
    WEB = 0,
    MACOS = 1,
}

export interface PlatformApi {
    /// Get the platform type
    platformType: PlatformType;
    /// Get the logger
    logger: PlatformLogger;
    /// Get the Hyper database client
    hyperDatabaseClient: HyperDatabaseClient | null;
}
