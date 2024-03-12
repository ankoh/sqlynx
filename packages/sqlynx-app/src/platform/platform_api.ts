import { HyperDatabaseClient } from "./platform_hyperdb_client.js";

export enum PlatformType {
    BROWSER = 0,
    MACOS = 1,
}

export interface PlatformApi {
    /// Get the platform type
    getPlatformType(): PlatformType;
    /// Get the Hyper database client
    getHyperDatabaseClient(): HyperDatabaseClient;
}
