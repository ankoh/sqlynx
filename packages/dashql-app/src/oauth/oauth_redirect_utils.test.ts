import { describe, expect, it } from 'vitest';

import type { OAuthState } from './oauth_types.js';
import { isAllowedOAuthCallbackUrl, validateOAuthRedirectState } from './oauth_redirect_utils.js';

function makeState(expiresAt = 2_000): OAuthState {
    return {
        flowId: 'flow-id',
        flowVariant: 'WEB_OPENER_FLOW',
        debugMode: false,
        salesforceProvider: {
            instanceUrl: 'https://example.my.salesforce.com',
            appConsumerKey: 'consumer-key',
            requestedAt: 1_000,
            expiresAt,
        },
    };
}

describe('OAuth callback relay', () => {
    const currentUrl = new URL('https://dashql.app/oauth.html');

    it.each([
        'https://dashql.app/oauth.html',
        'https://hyperdb.sh/oauth.html',
        'http://localhost:5173/oauth.html',
        'https://127.0.0.1:9002/oauth.html',
    ])('allows %s', callbackUrl => {
        expect(isAllowedOAuthCallbackUrl(callbackUrl, currentUrl)).toBe(true);
    });

    it.each([
        'https://evil.example/oauth.html',
        'https://dashql.app/other.html',
        'https://dashql.app:444/oauth.html',
        'https://dashql.app/oauth.html?next=https://evil.example',
        'https://dashql.app.evil.example/oauth.html',
        'javascript:alert(1)',
        'http://192.168.1.10:5173/oauth.html',
    ])('rejects %s', callbackUrl => {
        expect(isAllowedOAuthCallbackUrl(callbackUrl, currentUrl)).toBe(false);
    });

    it('allows an exact same current origin', () => {
        expect(isAllowedOAuthCallbackUrl(
            'https://preview.example:8443/oauth.html',
            new URL('https://preview.example:8443/oauth.html'),
        )).toBe(true);
    });
});

describe('OAuth redirect state validation', () => {
    it('accepts a complete unexpired state', () => {
        expect(() => validateOAuthRedirectState(makeState(), 1_500)).not.toThrow();
    });

    it('rejects missing flow IDs and expired state', () => {
        expect(() => validateOAuthRedirectState({ ...makeState(), flowId: '' }, 1_500)).toThrow('flow ID');
        expect(() => validateOAuthRedirectState(makeState(1_500), 1_500)).toThrow('expired');
    });
});
