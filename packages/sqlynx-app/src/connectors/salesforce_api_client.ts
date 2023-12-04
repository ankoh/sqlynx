import { sleep } from '../utils/sleep';

export interface SalesforceAccessToken {
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

export function readAccessToken(obj: any): SalesforceAccessToken {
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

export interface UserInformationPhotos {
    picture: string | null;
    thumbnail: string | null;
}

export interface SalesforceUserInformation {
    active: boolean | null;
    email: string | null;
    emailVerified: boolean | null;
    familyName: string | null;
    givenName: string | null;
    isAppInstalled: boolean | null;
    isSalesforceIntegrationUser: boolean | null;
    language: string | null;
    locale: string | null;
    name: string | null;
    nickname: string | null;
    organizationId: string | null;
    photos: UserInformationPhotos | null;
    picture: string | null;
    preferredUsername: string | null;
    profile: string | null;
    sub: string | null;
    updatedAt: string | null;
    userId: string | null;
    userType: string | null;
    utcOffset: number | null;
    zoneinfo: string | null;
}

export function readUserInformation(obj: any): SalesforceUserInformation {
    return {
        active: obj.active ?? null,
        email: obj.email ?? null,
        emailVerified: obj.email_verified ?? null,
        familyName: obj.family_name ?? null,
        givenName: obj.given_name ?? null,
        isAppInstalled: obj.is_app_installed ?? null,
        isSalesforceIntegrationUser: obj.is_salesforce_integration_user ?? null,
        language: obj.language ?? null,
        locale: obj.locale ?? null,
        name: obj.name ?? null,
        nickname: obj.nickname ?? null,
        organizationId: obj.organization_id ?? null,
        photos: obj.photos ?? null,
        picture: obj.picture ?? null,
        preferredUsername: obj.preferred_username ?? null,
        profile: obj.profile ?? null,
        sub: obj.sub ?? null,
        updatedAt: obj.updated_at ?? null,
        userId: obj.user_id ?? null,
        userType: obj.user_type ?? null,
        utcOffset: obj.utcOffset ?? null,
        zoneinfo: obj.zoneinfo ?? null,
    };
}

export interface SalesforceAPIClientInterface {
    /// Is authenticated?
    isAuthenticated(): boolean;
    /// Get the user information
    getUserInfo(cancel: AbortSignal): Promise<SalesforceUserInformation>;
}

export class SalesforceAPIClient implements SalesforceAPIClientInterface {
    protected access: SalesforceAccessToken | null;

    constructor(token: SalesforceAccessToken | null) {
        this.access = token;
    }

    public isAuthenticated() {
        return this.access != null;
    }

    protected throwIfNotAuthenticated(): SalesforceAccessToken {
        if (this.access == null) {
            throw new Error('not authenticated');
        }
        return this.access;
    }

    public async getUserInfo(cancel: AbortSignal): Promise<SalesforceUserInformation> {
        const access = this.throwIfNotAuthenticated();
        const params = new URLSearchParams();
        params.set('format', 'json');
        params.set('access_token', access.accessToken ?? '');
        const response = await fetch(`${access.instanceUrl}/services/oauth2/userinfo?${params.toString()}`, {
            signal: cancel,
        });
        const responseJson = await response.json();
        const responseInfo = readUserInformation(responseJson);
        console.log(responseInfo);
        return responseInfo;
    }
}

export class MockSalesforceAPIClient implements SalesforceAPIClientInterface {
    authenticated: boolean;

    constructor(authenticated: boolean) {
        this.authenticated = authenticated;
    }
    isAuthenticated(): boolean {
        return this.authenticated;
    }
    protected throwIfNotAuthenticated() {
        if (!this.authenticated) {
            throw new Error('not authenticated');
        }
    }
    async getUserInfo(_cancel: AbortSignal): Promise<SalesforceUserInformation> {
        this.throwIfNotAuthenticated();
        /// Wait for 1 second to simulate initial loading
        await sleep(1000);
        // Construct a dummy user information
        return {
            active: true,
            email: 'test@salesforce.com',
            emailVerified: true,
            familyName: 'John',
            givenName: 'Does',
            isAppInstalled: true,
            isSalesforceIntegrationUser: false,
            language: 'en/us',
            locale: 'en/us',
            name: 'Doe',
            nickname: 'John',
            organizationId: 'aswerwetaz',
            photos: {
                picture: '',
                thumbnail: '',
            },
            picture: '',
            preferredUsername: 'john.doe',
            profile: '',
            sub: '',
            updatedAt: '',
            userId: '',
            userType: '',
            utcOffset: 1,
            zoneinfo: '',
        };
    }
}
