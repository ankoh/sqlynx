/// Is a running natively?
export function isNativePlatform(): boolean {
    return '__TAURI__' in (globalThis as any);
}
