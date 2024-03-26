/// Function that can be called to unregister a listener
export type Unlistener = () => void;

/// The globals provided by tauri
export interface NativeGlobals {
    core: {
        convertFileSrc: (path: string, scheme: string) => string;
        invoke: (command: string, data?: any) => any;
    },
    event: {
        emit: (topic: string) => Promise<void>;
        listen: (topic: string, consumer: (event: any) => void) => Promise<Unlistener>;
    }
}

/// The tauri globals
const TAURI = ((globalThis as any).__TAURI__ as NativeGlobals) ?? null;
/// Is a running natively?
export function isNativePlatform(): boolean {
    return TAURI != null;
}
/// Get the native globals
export function getNativeGlobals(): NativeGlobals {
    return TAURI;
}
