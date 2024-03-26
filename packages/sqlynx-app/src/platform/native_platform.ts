import { PlatformApi, PlatformType } from './platform_api.js';
import { NativeHyperDatabaseClient } from './native_hyperdb_client.js';
import { getNativeGlobals } from './native_globals.js';
import { NativeLogger } from './native_logger.js';
import { LogBuffer } from './log_buffer.js';

/// Initialize the native api, if we're running in a Native app
export async function setupNativePlatform(logBuffer: LogBuffer): Promise<PlatformApi | null> {
    const globals = getNativeGlobals();

    // Not running in tauri? (e.g. regular web app?)
    // Silently stop.
    if (globals == null) {
        return null;
    }
    console.log(globals);

    // Test command call
    const os = await globals.core.invoke("sqlynx_get_os");
    console.log(os);

    // // Test streaming call via custom scheme
    // const path = globals.core.convertFileSrc("foo", "sqlynx-native");
    // const response = await fetch(path);
    // console.log(await response.text());

    // Build the api client
    return {
        /// The platform type
        platformType: PlatformType.MACOS,
        /// The native logger
        logger: new NativeLogger(globals, logBuffer),
        /// The Hyper database client
        hyperDatabaseClient: new NativeHyperDatabaseClient({ proxyEndpoint: new URL("sqlynx-native://localhost") }),
    };
};
