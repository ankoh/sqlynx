export interface AccessToken {
    /// The OAuth token
    access_token: string;
    /// The instance url
    api_instance_url: string;
    /// An identity URL that can be used to identify the user and to query
    id: string;
    /// A signed data structure that contains authenticated user attributes
    id_token: string;
    /// A URL indicating the instance of the user’s org
    instance_url: string;
    /// Time stamp of when the signature was created in milliseconds
    issued_at: string;
    /// Token obtained from the web server, user-agent, or hybrid app token flow
    refresh_token?: string;
    /// The scopes associated with the access token.
    scope: string;
    /// Base64-encoded HMAC-SHA256 signature
    signature: string;
    /// A Bearer token type
    token_type: string;
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
        params.set('access_token', access.access_token);
        const response = await fetch(`${access.instance_url}/services/oauth2/userinfo?${params.toString()}`, {
            signal: cancel,
        });
        const responseJson = await response.json();
        console.log(responseJson);
        return responseJson as UserInformation;
    }
}
