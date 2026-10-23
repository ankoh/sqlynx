import type { OAuthState } from './oauth_types.js';

const PUBLIC_OAUTH_ORIGINS = new Set(['https://dashql.app', 'https://hyperdb.sh']);
const DEVELOPMENT_OAUTH_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isAllowedOAuthCallbackUrl(callbackUrl: string, currentUrl: URL): boolean {
    let target: URL;
    try {
        target = new URL(callbackUrl);
    } catch {
        return false;
    }
    if (target.pathname !== '/oauth.html' || target.search || target.username || target.password || target.hash) {
        return false;
    }
    if (target.origin === currentUrl.origin) {
        return true;
    }
    if (PUBLIC_OAUTH_ORIGINS.has(target.origin)) {
        return true;
    }
    return (target.protocol === 'http:' || target.protocol === 'https:')
        && DEVELOPMENT_OAUTH_HOSTS.has(target.hostname);
}

export function validateOAuthRedirectState(state: OAuthState, now = Date.now()): void {
    if (!state || typeof state !== 'object') {
        throw new Error('OAuth state is missing');
    }
    if (typeof state.flowId !== 'string' || state.flowId.length === 0) {
        throw new Error('OAuth state has no flow ID');
    }
    if (state.flowVariant !== 'WEB_OPENER_FLOW' && state.flowVariant !== 'NATIVE_LINK_FLOW') {
        throw new Error('OAuth state has an invalid flow variant');
    }
    const provider = state.salesforceProvider;
    if (!provider
        || typeof provider.instanceUrl !== 'string'
        || typeof provider.appConsumerKey !== 'string'
        || typeof provider.expiresAt !== 'number') {
        throw new Error('OAuth state has an invalid Salesforce provider');
    }
    if (provider.expiresAt <= now) {
        throw new Error('OAuth state has expired');
    }
}
