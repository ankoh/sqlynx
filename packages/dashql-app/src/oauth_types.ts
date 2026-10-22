export interface OAuthState {
    flowId: string;
    flowVariant: 'UNSPECIFIED_FLOW' | 'WEB_OPENER_FLOW' | 'NATIVE_LINK_FLOW';
    debugMode: boolean;
    callbackUrl?: string;
    salesforceProvider?: {
        instanceUrl: string;
        appConsumerKey: string;
        requestedAt: number;
        expiresAt: number;
    };
}

export interface OAuthRedirectData {
    state: OAuthState;
    code?: string;
    error?: string;
    errorDescription?: string;
}

export interface AppEventData {
    session?: string;
    oauthRedirect?: OAuthRedirectData;
}
