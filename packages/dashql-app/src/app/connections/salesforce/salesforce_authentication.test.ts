import * as auth from '@ankoh/dashql-jsonschema/auth.js';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OAuthState } from '../../../oauth_types.js';
import { Logger } from '../../../platform/logger/logger.js';
import { PlatformType } from '../../../platform/platform_type.js';
import { BASE64URL_CODEC } from '../../../utils/base64.js';
import type { SalesforceApiClientInterface } from './salesforce_api_client.js';
import {
    authenticateSalesforce,
    buildSalesforceAuthorizationUrl,
    validateSalesforceOAuthCallbackState,
} from './salesforce_authentication.js';

class NullLogger extends Logger {
    public destroy(): void { }
    protected flushPendingRecords(): void { }
}

const params: connection.SalesforceConnectionParams = {
    hyperProtocol: 'V3_HTTP',
    instanceUrl: 'https://example.my.salesforce.com',
    appConsumerKey: 'consumer+key',
    appConsumerSecret: '',
    login: 'test+oauth@example.com',
};
const authConfig: connection.SalesforceOAuthConfig = {
    oauthRedirect: 'https://dashql.app/oauth.html',
};
const coreAccessToken: connection.SalesforceCoreAccessToken = {
    createdAt: new Date(0).toISOString(),
    accessToken: 'core-token',
};
const dataCloudAccessToken: connection.SalesforceDataCloudAccessToken = {
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(7_200_000).toISOString(),
    instanceUrl: 'https://hyper.example.com',
    jwt: {
        raw: 'data-cloud-token',
        header: { alg: 'RS256' },
        payload: {
            exp: 7_200,
            audienceTenantId: 'tenant-id',
            sfoid: 'org-id',
        },
    },
};

function makeState(overrides: Partial<OAuthState> = {}): OAuthState {
    return {
        flowId: 'flow-id',
        flowVariant: 'WEB_OPENER_FLOW',
        debugMode: false,
        salesforceProvider: {
            instanceUrl: params.instanceUrl,
            appConsumerKey: params.appConsumerKey,
            requestedAt: 1_000,
            expiresAt: 2_000,
        },
        ...overrides,
    };
}

function decodeState(url: URL): OAuthState {
    const encoded = url.searchParams.get('state')!;
    return JSON.parse(new TextDecoder().decode(BASE64URL_CODEC.decode(encoded)));
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Salesforce OAuth URL', () => {
    it('encodes all parameters with URLSearchParams and uses the PKCE S256 parameter', () => {
        const url = buildSalesforceAuthorizationUrl(
            params,
            authConfig,
            { value: 'challenge', verifier: 'verifier' } as auth.OAuthPKCEChallenge,
            makeState(),
            true,
        );

        expect(url.origin + url.pathname).toBe('https://example.my.salesforce.com/services/oauth2/authorize');
        expect(url.searchParams.get('client_id')).toBe('consumer+key');
        expect(url.searchParams.get('login_hint')).toBe('test+oauth@example.com');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.has('code_challange_method')).toBe(false);
        expect(url.searchParams.get('prompt')).toBe('login');
        expect(decodeState(url)).toEqual(makeState());
    });
});

describe('Salesforce OAuth callback state', () => {
    it('validates the flow ID, provider, variant, and expiration', () => {
        const expected = makeState();
        expect(() => validateSalesforceOAuthCallbackState({ state: expected, code: 'code' }, expected, 1_500)).not.toThrow();
        expect(() => validateSalesforceOAuthCallbackState(
            { state: { ...expected, flowId: 'other' }, code: 'code' },
            expected,
            1_500,
        )).toThrow('flow ID');
        expect(() => validateSalesforceOAuthCallbackState(
            { state: { ...expected, flowVariant: 'NATIVE_LINK_FLOW' }, code: 'code' },
            expected,
            1_500,
        )).toThrow('flow variant');
        expect(() => validateSalesforceOAuthCallbackState(
            {
                state: {
                    ...expected,
                    salesforceProvider: { ...expected.salesforceProvider!, appConsumerKey: 'other' },
                },
                code: 'code',
            },
            expected,
            1_500,
        )).toThrow('provider');
        expect(() => validateSalesforceOAuthCallbackState({ state: expected, code: 'code' }, expected, 2_000)).toThrow('expired');
    });
});

describe('authenticateSalesforce', () => {
    it('returns both tokens and optional user info through staged progress', async () => {
        const popup = { closed: false, close: vi.fn(), focus: vi.fn() } as unknown as Window;
        const open = vi.spyOn(window, 'open').mockReturnValue(popup);
        const logger = new NullLogger();
        const info = vi.spyOn(logger, 'info');
        const coreUserInfo = { preferredUsername: 'user@example.com', photos: {} } as connection.SalesforceCoreUserInfo;
        const apiClient = {
            getCoreAccessToken: vi.fn().mockResolvedValue(coreAccessToken),
            getCoreUserInfo: vi.fn().mockResolvedValue(coreUserInfo),
            getDataCloudAccessToken: vi.fn().mockResolvedValue(dataCloudAccessToken),
        } as unknown as SalesforceApiClientInterface;
        const appEvents = {
            waitForOAuthRedirect: vi.fn().mockImplementation(async () => {
                const state = decodeState(new URL(open.mock.calls[0][0]!.toString()));
                return { state, code: 'authorization-code' };
            }),
        };
        const stages: string[] = [];

        const result = await authenticateSalesforce({
            logger,
            params,
            authConfig,
            platformType: PlatformType.WEB,
            apiClient,
            appEvents: appEvents as any,
            forceReLogin: false,
            abortSignal: new AbortController().signal,
            onProgress: progress => stages.push(progress.stage),
        });

        expect(result).toEqual({ coreAccessToken, dataCloudAccessToken, coreUserInfo });
        expect(apiClient.getDataCloudAccessToken).toHaveBeenCalledWith(coreAccessToken, expect.any(AbortSignal));
        expect(info).toHaveBeenCalledWith('Opening Salesforce OAuth authorization URL', expect.objectContaining({
            endpoint: 'https://example.my.salesforce.com/services/oauth2/authorize',
            flowVariant: 'WEB_OPENER_FLOW',
            authorizationParameters: expect.stringContaining('"client_id":"consumer+key"'),
            oauthState: expect.stringContaining('"flowId":"<redacted>"'),
        }), 'salesforce_authentication');
        const authorizationParameters = JSON.parse(info.mock.calls[0][1].authorizationParameters!);
        expect(authorizationParameters.redirect_uri).toBe('https://dashql.app/oauth.html');
        expect(authorizationParameters.code_challenge_method).toBe('S256');
        expect(authorizationParameters.response_type).toBe('code');
        expect(authorizationParameters.state).toBe('<redacted>');
        expect(authorizationParameters.code_challenge).toBe('<redacted>');
        const oauthRequestLog = JSON.stringify(info.mock.calls);
        expect(oauthRequestLog).not.toContain('test+oauth@example.com');
        expect(apiClient.getCoreUserInfo).toHaveBeenCalledWith(coreAccessToken, expect.any(AbortSignal));
        expect(popup.close).toHaveBeenCalledOnce();
        expect(stages).toEqual([
            'GENERATING_PKCE_CHALLENGE',
            'GENERATED_PKCE_CHALLENGE',
            'OAUTH_WEB_WINDOW_OPENED',
            'OAUTH_WEB_WINDOW_CLOSED',
            'RECEIVED_CORE_AUTH_CODE',
            'REQUESTING_CORE_AUTH_TOKEN',
            'RECEIVED_CORE_AUTH_TOKEN',
            'RECEIVED_CORE_USER_INFO',
            'REQUESTING_DATA_CLOUD_ACCESS_TOKEN',
            'RECEIVED_DATA_CLOUD_ACCESS_TOKEN',
        ]);
    });

    it('opens native OAuth in the system browser and waits for a deep-link callback', async () => {
        const openExternal = vi.fn();
        vi.stubGlobal('dashqlElectron', { openExternal });
        const open = vi.spyOn(window, 'open');
        const apiClient = {
            getCoreAccessToken: vi.fn().mockResolvedValue(coreAccessToken),
            getCoreUserInfo: vi.fn().mockRejectedValue(new Error('unavailable')),
            getDataCloudAccessToken: vi.fn().mockResolvedValue(dataCloudAccessToken),
        } as unknown as SalesforceApiClientInterface;
        const appEvents = {
            waitForOAuthRedirect: vi.fn().mockImplementation(async () => {
                const state = decodeState(new URL(openExternal.mock.calls[0][0]));
                return { state, code: 'authorization-code' };
            }),
        };
        const stages: string[] = [];

        await expect(authenticateSalesforce({
            logger: new NullLogger(),
            params,
            authConfig,
            platformType: PlatformType.MACOS,
            apiClient,
            appEvents: appEvents as any,
            forceReLogin: false,
            abortSignal: new AbortController().signal,
            onProgress: progress => stages.push(progress.stage),
        })).resolves.toEqual({ coreAccessToken, dataCloudAccessToken, coreUserInfo: undefined });

        expect(open).not.toHaveBeenCalled();
        expect(openExternal).toHaveBeenCalledOnce();
        expect(decodeState(new URL(openExternal.mock.calls[0][0])).flowVariant).toBe('NATIVE_LINK_FLOW');
        expect(stages).toContain('OAUTH_NATIVE_LINK_OPENED');
    });

    it('propagates OAuth error descriptions and closes the popup', async () => {
        const popup = { closed: false, close: vi.fn(), focus: vi.fn() } as unknown as Window;
        const open = vi.spyOn(window, 'open').mockReturnValue(popup);
        const appEvents = {
            waitForOAuthRedirect: vi.fn().mockImplementation(async () => {
                const state = decodeState(new URL(open.mock.calls[0][0]!.toString()));
                return { state, error: 'access_denied', errorDescription: 'The user denied access' };
            }),
        };

        await expect(authenticateSalesforce({
            logger: new NullLogger(),
            params,
            authConfig,
            platformType: PlatformType.WEB,
            apiClient: {} as SalesforceApiClientInterface,
            appEvents: appEvents as any,
            forceReLogin: false,
            abortSignal: new AbortController().signal,
        })).rejects.toThrow('The user denied access');
        expect(popup.close).toHaveBeenCalledOnce();
    });

    it.each(['failed', 'aborted'])('does not report a received Data Cloud token when the exchange is %s', async outcome => {
        const popup = { closed: false, close: vi.fn(), focus: vi.fn() } as unknown as Window;
        const open = vi.spyOn(window, 'open').mockReturnValue(popup);
        const abort = new AbortController();
        const stages: string[] = [];
        const apiClient = {
            getCoreAccessToken: vi.fn().mockResolvedValue(coreAccessToken),
            getCoreUserInfo: vi.fn().mockResolvedValue({ photos: {} }),
            getDataCloudAccessToken: vi.fn(async () => {
                if (outcome === 'failed') throw new Error('exchange failed');
                abort.abort();
                return dataCloudAccessToken;
            }),
        } as unknown as SalesforceApiClientInterface;
        const appEvents = {
            waitForOAuthRedirect: vi.fn(async () => ({
                state: decodeState(new URL(open.mock.calls[0][0]!.toString())),
                code: 'authorization-code',
            })),
        };
        await expect(authenticateSalesforce({
            logger: new NullLogger(), params, authConfig, platformType: PlatformType.WEB,
            apiClient, appEvents: appEvents as any, forceReLogin: false,
            abortSignal: abort.signal, onProgress: progress => stages.push(progress.stage),
        })).rejects.toThrow();
        expect(stages).toContain('REQUESTING_DATA_CLOUD_ACCESS_TOKEN');
        expect(stages).not.toContain('RECEIVED_DATA_CLOUD_ACCESS_TOKEN');
        expect(popup.close).toHaveBeenCalledOnce();
    });

    it('closes the popup when waiting for the callback is aborted', async () => {
        const popup = { closed: false, close: vi.fn(), focus: vi.fn() } as unknown as Window;
        vi.spyOn(window, 'open').mockReturnValue(popup);
        const abort = new AbortController();
        const appEvents = {
            waitForOAuthRedirect: vi.fn().mockImplementation(async () => {
                abort.abort();
                abort.signal.throwIfAborted();
            }),
        };

        await expect(authenticateSalesforce({
            logger: new NullLogger(),
            params,
            authConfig,
            platformType: PlatformType.WEB,
            apiClient: {} as SalesforceApiClientInterface,
            appEvents: appEvents as any,
            forceReLogin: false,
            abortSignal: abort.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(popup.close).toHaveBeenCalledOnce();
    });
});
