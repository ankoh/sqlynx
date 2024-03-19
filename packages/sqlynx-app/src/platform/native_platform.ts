import { PlatformApi, PlatformType } from './platform_api.js';
import { NativeHyperDatabaseClient } from './native_hyperdb_client.js';

/// The globals provided by tauri
interface NativeGlobals {
    core: {
        convertFileSrc: (path: string, scheme: string) => string;
        invoke: (command: string) => any;
    }
}

/// The tauri globals
const TAURI = ((window as any).__TAURI__ as NativeGlobals) ?? null;

/// Is a running natively?
export function isNativePlatform(): boolean {
    return TAURI != null;
}

/// Initialize the native api, if we're running in a Native app
export async function setupNativePlatform(setApi: (api: PlatformApi) => void) {
    // Not running in tauri? (e.g. regular web app?)
    // Silently stop.
    if (TAURI == null) {
        return;
    }
    console.log(TAURI);

    // Test command call
    const os = await TAURI.core.invoke("sqlynx_get_os");
    console.log(os);
    // Test streaming call via custom scheme
    const path = TAURI.core.convertFileSrc("foo", "sqlynx-native");
    const response = await fetch(path);
    console.log(await response.text());

    // Build the api client
    setApi({
        getPlatformType: () => PlatformType.MACOS,
        getHyperDatabaseClient: () => new NativeHyperDatabaseClient({ proxyEndpoint: new URL("sqlynx-native://localhost") }),
    });
};
