export interface HyperDBWebCapabilities {
    readonly crossOriginIsolated: boolean;
    readonly hasSharedArrayBuffer: boolean;
    readonly maxTouchPoints: number;
    readonly platform: string;
    readonly userAgent: string;
}

function readWebCapabilities(): HyperDBWebCapabilities {
    return {
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        maxTouchPoints: navigator.maxTouchPoints,
        platform: navigator.platform,
        userAgent: navigator.userAgent,
    };
}

export function isIOS(capabilities: HyperDBWebCapabilities): boolean {
    return /iPad|iPhone|iPod/.test(capabilities.userAgent)
        || (capabilities.platform === 'MacIntel' && capabilities.maxTouchPoints > 1);
}

export function getHyperDBWebSupportError(
    capabilities: HyperDBWebCapabilities = readWebCapabilities(),
): string | null {
    if (isIOS(capabilities)) {
        return 'HyperDB is not supported on iOS browsers. Open this shell from a desktop browser instead.';
    }
    if (!capabilities.hasSharedArrayBuffer || !capabilities.crossOriginIsolated) {
        return 'HyperDB requires SharedArrayBuffer and a cross-origin-isolated page.';
    }
    return null;
}
