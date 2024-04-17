import * as tauri from "@tauri-apps/api";

/// Is a running natively?
export function isNativePlatform(): boolean {
    return '__TAURI__' in (globalThis as any);
}

/// Is the native side built with debug flags?
/// We assume that debug builds are not registered properly to receive deep-links from the OS.
export async function isNativeDebugBuild(): Promise<boolean> {
    return await tauri.core.invoke("sqlynx_is_debug_build") as boolean;
}
