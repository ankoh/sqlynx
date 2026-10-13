import { describe, expect, it } from 'vitest';

import { getHyperDBWebSupportError, isIOS, type HyperDBWebCapabilities } from './hyperdb_web_support.js';

function capabilities(overrides: Partial<HyperDBWebCapabilities> = {}): HyperDBWebCapabilities {
    return {
        crossOriginIsolated: true,
        hasSharedArrayBuffer: true,
        maxTouchPoints: 0,
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
        ...overrides,
    };
}

describe('HyperDB web support', () => {
    it('rejects iPhone browsers before HyperDB initialization', () => {
        const runtime = capabilities({
            platform: 'iPhone',
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        });

        expect(isIOS(runtime)).toBe(true);
        expect(getHyperDBWebSupportError(runtime)).toBe(
            'HyperDB is not supported on iOS browsers. Open this shell from a desktop browser instead.',
        );
    });

    it('recognizes iPadOS desktop-mode user agents', () => {
        const runtime = capabilities({ maxTouchPoints: 5 });

        expect(isIOS(runtime)).toBe(true);
        expect(getHyperDBWebSupportError(runtime)).not.toBeNull();
    });

    it('explains missing isolation for supported desktop browsers', () => {
        expect(getHyperDBWebSupportError(capabilities({ crossOriginIsolated: false }))).toBe(
            'HyperDB requires SharedArrayBuffer and a cross-origin-isolated page.',
        );
    });

    it('accepts isolated desktop browsers with SharedArrayBuffer', () => {
        expect(getHyperDBWebSupportError(capabilities())).toBeNull();
    });
});
