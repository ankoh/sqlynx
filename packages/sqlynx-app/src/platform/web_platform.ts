import { PlatformApi, PlatformType } from "./platform_api.js";

/// Initialize the native api, if we're running in a Native app
export async function setupWebPlatform(setApi: (api: PlatformApi) => void) {
    // Build the api client
    setApi({
        getPlatformType: () => PlatformType.WEB,
        getHyperDatabaseClient: () => null,
    });
};
