export interface AccessToken {
    /// The OAuth token
    accessToken: string | null;
    /// The instance url
    apiInstanceUrl: string | null;
    /// An identity URL that can be used to identify the user and to query
    id: string | null;
    /// A signed data structure that contains authenticated user attributes
    idToken: string | null;
    /// A URL indicating the instance of the user’s org
    instanceUrl: string | null;
    /// Time stamp of when the signature was created in milliseconds
    issuedAt: string | null;
    /// Token obtained from the web server, user-agent, or hybrid app token flow
    refreshToken: string | null;
    /// The scopes associated with the access token.
    scope: string | null;
    /// Base64-encoded HMAC-SHA256 signature
    signature: string | null;
    /// A Bearer token type
    tokenType: string | null;
}

export function readAccessToken(obj: any): AccessToken {
    return {
        accessToken: obj.access_token ?? null,
        apiInstanceUrl: obj.api_instance_url ?? null,
        id: obj.id ?? null,
        idToken: obj.id_token ?? null,
        instanceUrl: obj.instance_url ?? null,
        issuedAt: obj.issued_at ?? null,
        refreshToken: obj.refresh_token ?? null,
        scope: obj.scope ?? null,
        signature: obj.signature ?? null,
        tokenType: obj.token_type ?? null,
    };
}

export interface UserInformation {
    active: boolean;
    email: string;
    email_verified: boolean;
    family_name: string;
    given_name: string;
    is_app_installed: boolean;
    is_salesforce_integration_user: boolean;
    language: string;
    locale: string;
    name: string;
    nickname: string;
    organization_id: string;
    photos: {
        picture: string;
        thumbnail: string;
    };
    picture: string;
    preferred_username: string;
    profile: string;
    sub: string;
    updated_at: string;
    user_id: string;
    user_type: string;
    utcOffset: number;
    zoneinfo: string;
}

// export function readerUserInformation(): AccessToken {
//
// }

export class SalesforceAPIClient {
    protected access: AccessToken | null;

    constructor(token: AccessToken | null) {
        this.access = token;
    }

    public get isAuthenticated() {
        return this.access != null;
    }

    protected throwIfNotAuthenticated(): AccessToken {
        if (this.access == null) {
            throw new Error('not authenticated');
        }
        return this.access;
    }

    public async getUserInfo(cancel: AbortSignal): Promise<UserInformation> {
        const access = this.throwIfNotAuthenticated();
        const params = new URLSearchParams();
        params.set('format', 'json');
        params.set('access_token', access.accessToken ?? '');
        const response = await fetch(`${access.instanceUrl}/services/oauth2/userinfo?${params.toString()}`, {
            signal: cancel,
        });
        const responseJson = await response.json();
        console.log(responseJson);
        return responseJson as UserInformation;
    }
}
