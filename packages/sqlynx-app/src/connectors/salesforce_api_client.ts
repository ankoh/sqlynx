import { sleep } from '../utils/sleep';

import SalesforceDummyAccount from '../../static/img/salesforce_account_placeholder.png';

export interface SalesforceCoreAccessToken {
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

export interface SalesforceDataCloudAccessToken {
    /// The access token
    accessToken: string | null;
    /// The expiration time
    expiresAt: Date | null;
    /// The instance URL
    instanceUrl: URL | null;
    /// The issued token type
    issuedTokenType: string;
    /// The token type
    tokenType: string;
}

export interface SalesforceUserInfoPhotos {
    picture: string | null;
    thumbnail: string | null;
}

export interface SalesforceUserInfo {
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
    photos: SalesforceUserInfoPhotos | null;
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

export interface SalesforceMetadataEntityField {
    name: string;
    displayName: string;
    type: string;
    businessType: string;
}

export interface SalesforceMetadataPrimaryKey {
    indexOrder: string;
    name: string;
    displayName: string;
}

export interface SalesforceMetadataEntity {
    name: string;
    displayName: string;
    category: string;
    fields: SalesforceMetadataEntityField[];
    primaryKeys: SalesforceMetadataPrimaryKey[];
}

export interface SalesforceMetadata {
    metadata: SalesforceMetadataEntity[];
}

export function readCoreAccessToken(obj: any): SalesforceCoreAccessToken {
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

export function readDataCloudAccessToken(obj: any): SalesforceDataCloudAccessToken {
    const expiration = new Date();
    if (obj.expires_in) {
        expiration.setSeconds(expiration.getSeconds() + obj.expires_in);
    }
    const prependProtoIfMissing = (urlString: string) => {
        if (!urlString.startsWith('https:')) {
            urlString = `https://${urlString}`;
        }
        console.log(urlString);
        return new URL(urlString);
    };
    return {
        accessToken: obj.access_token ?? null,
        expiresAt: obj.expires_in ? expiration : null,
        instanceUrl: obj.instance_url ? prependProtoIfMissing(obj.instance_url) : null,
        issuedTokenType: obj.issued_token_type ?? null,
        tokenType: obj.token_type ?? null,
    };
}

export function readUserInformation(obj: any): SalesforceUserInfo {
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
    getUserInfo(access: SalesforceCoreAccessToken, cancel: AbortSignal): Promise<SalesforceUserInfo>;
    getMetadata(access: SalesforceDataCloudAccessToken, cancel: AbortSignal): Promise<SalesforceMetadata>;
}

export class SalesforceAPIClient implements SalesforceAPIClientInterface {
    public async getUserInfo(access: SalesforceCoreAccessToken, cancel: AbortSignal): Promise<SalesforceUserInfo> {
        const params = new URLSearchParams();
        params.set('format', 'json');
        params.set('access_token', access.accessToken ?? '');
        const response = await fetch(`${access.instanceUrl}/services/oauth2/userinfo?${params.toString()}`, {
            signal: cancel,
        });
        const responseJson = await response.json();
        const responseInfo = readUserInformation(responseJson);
        return responseInfo;
    }

    public async getMetadata(access: SalesforceDataCloudAccessToken, cancel: AbortSignal): Promise<SalesforceMetadata> {
        const params = new URLSearchParams();
        console.log(access.instanceUrl);
        const response = await fetch(`${access.instanceUrl}api/v1/metadata?${params.toString()}`, {
            headers: {
                authorization: `Bearer ${access.accessToken}`,
            },
            signal: cancel,
        });
        const responseJson = await response.json();
        console.log(responseJson);
        return responseJson as SalesforceMetadata;
    }
}

export class SalesforceAPIClientMock implements SalesforceAPIClientInterface {
    async getUserInfo(_access: SalesforceCoreAccessToken, _cancel: AbortSignal): Promise<SalesforceUserInfo> {
        /// Wait for 1 second to simulate initial loading
        await sleep(200);
        // Construct a dummy user information
        return {
            active: true,
            email: 'test@salesforce.com',
            emailVerified: true,
            familyName: 'John',
            givenName: 'Doe',
            isAppInstalled: true,
            isSalesforceIntegrationUser: false,
            language: 'en_US',
            locale: 'en_US',
            name: 'John Doe',
            nickname: 'User17006129999744530151',
            organizationId: '00DRZ01110039JE2AY',
            photos: {
                picture: SalesforceDummyAccount,
                thumbnail: null,
            },
            picture: '',
            preferredUsername: 'epic.john.doe@salesforce.com',
            profile: '',
            sub: '',
            updatedAt: '',
            userId: '005RZ0000002ZbBYAU',
            userType: 'STANDARD',
            utcOffset: -28800000,
            zoneinfo: 'America/Los_Angeles',
        };
    }
    public async getMetadata(
        _access: SalesforceDataCloudAccessToken,
        _cancel: AbortSignal,
    ): Promise<SalesforceMetadata> {
        return {
            metadata: [],
        };
    }
}
