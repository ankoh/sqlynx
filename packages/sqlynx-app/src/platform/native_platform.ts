import { PlatformApi, PlatformType } from './platform_api.js';
import { NativeHyperDatabaseClient } from './native_hyperdb_client.js';

/// The globals provided by tauri
interface NativeGlobals {
    core: {
        convertFileSrc: (path: string, scheme: string) => string;
        invoke: (command: string) => any;
    }
}

/// Initialize the native api, if we're running in a Native app
export async function setupNativePlatform(setApi: (api: PlatformApi) => void) {
    const tauri = (window as any).__TAURI__ as NativeGlobals;

    // Not running in tauri? (e.g. regular web app?)
    // Silently stop.
    if (tauri === undefined) {
        return;
    }
    console.log(tauri);

    // Test command call
    const os = await tauri.core.invoke("sqlynx_get_os");
    console.log(os);
    // Test streaming call via custom scheme
    const path = tauri.core.convertFileSrc("foo", "sqlynx-native");
    const response = await fetch(path);
    console.log(await response.text());

    // Build the api client
    setApi({
        getPlatformType: () => PlatformType.MACOS,
        getHyperDatabaseClient: () => new NativeHyperDatabaseClient({ baseURL: new URL("sqlynx-native://[::1]") }),
    });
};
