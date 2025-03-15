import * as proto from "@ankoh/dashql-protobuf";

import { Logger } from '../../platform/logger.js';
import { HttpClient } from '../../platform/http_client.js';
import { SalesforceConnectionParams } from './salesforce_connection_params.js';
import { SalesforceAuthConfig } from '../connector_configs.js';
import { Base64Codec } from '../../utils/base64.js';
import { HealthCheckResult, HyperDatabaseChannel, HyperQueryResultStream } from '../hyper/hyperdb_client.js';
import { AsyncConsumer } from "../../utils/async_consumer.js";
import { QueryExecutionProgress } from "../../connection/query_execution_state.js";

const LOG_CTX = "salesforce_api";

export interface SalesforceCoreAccessToken {
    /// The OAuth token
    accessToken: string;
    /// A URL indicating the instance of the user’s org
    instanceUrl: string;
    /// The instance url
    apiInstanceUrl: string | null;
    /// An identity URL that can be used to identify the user and to query
    id: string | null;
    /// A signed data structure that contains authenticated user attributes
    idToken: string | null;
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
export interface SalesforceDataCloudJWTPayload {
    /// The JWT subject
    sub: string;
    /// The JWT audience
    aud: string;
    /// The JWT expiration time, seconds since epoch for SF
    exp: string;
    /// The time when the JWT was issued
    iat: string;
    //// The unique id of the JWT token
    jti: string;
    /// The JWT scope
    scp: string;
    /// The JWT issuer
    iss: string;
    /// The time when the JWT becomes valid
    nbf: string;

    /// The SF core org id
    orgId: string;
    /// The SF app id
    sfappid: string;
    /// The SF oid
    sfoid: string;
    /// The SF uid
    sfuid: string;

    /// The SF core tenant id of the issuer
    issuerTenantId: string;
    /// The SF offcore tenant id required for the DC api
    audienceTenantId: string;
    /// The custom attributes (contains "dataspace")
    customAttributes: Record<string, string>;
}

export interface SalesforceDataCloudJWT {
    /// The raw JWT string
    raw: string;
    /// The JWT header
    header: Record<string, string>;
    /// The JWT payload
    payload: SalesforceDataCloudJWTPayload;
}


export class SalesforceDataCloudAccessToken {
    /// The token type
    tokenType: string | null;
    /// The issued token type
    issuedTokenType: string | null;
    /// The expiration time
    expiresAt: Date;
    /// The jwt
    jwt: SalesforceDataCloudJWT;
    /// The instance URL
    instanceUrl: URL;

    constructor(tokenType: string | null, issuedTokenType: string | null, expiresAt: Date, jwt: SalesforceDataCloudJWT, instanceUrl: URL) {
        this.tokenType = tokenType;
        this.issuedTokenType = issuedTokenType;
        this.expiresAt = expiresAt;
        this.jwt = jwt;
        this.instanceUrl = instanceUrl;
    }

    /// The tenant id in core
    get coreTenantId(): string { return this.jwt.payload.issuerTenantId; }
    /// The tenant id in data cloud
    get dcTenantId(): string { return this.jwt.payload.audienceTenantId; }
    /// The dataspace in data cloud
    get dcDataspace(): string { return this.jwt.payload.customAttributes["dataspace"] ?? null; }
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
    metadata?: SalesforceMetadataEntity[];
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

export interface SalesforceApiClientInterface {
    getCoreAccessToken(
        authConfig: SalesforceAuthConfig,
        authParams: SalesforceConnectionParams,
        authCode: string,
        pkceVerifier: string,
        cancel: AbortSignal,
    ): Promise<SalesforceCoreAccessToken>;
    getCoreUserInfo(access: SalesforceCoreAccessToken, cancel: AbortSignal): Promise<SalesforceUserInfo>;
    getDataCloudAccessToken(
        access: SalesforceCoreAccessToken,
        cancel: AbortSignal,
    ): Promise<SalesforceDataCloudAccessToken>;
    getDataCloudMetadata(access: SalesforceDataCloudAccessToken, cancel: AbortSignal): Promise<SalesforceMetadata>;
}

export class SalesforceApiClient implements SalesforceApiClientInterface {
    logger: Logger;
    httpClient: HttpClient;
    base64Codec: Base64Codec;
    textDecoder: TextDecoder;

    constructor(logger: Logger, httpClient: HttpClient) {
        this.logger = logger;
        this.httpClient = httpClient;
        this.base64Codec = new Base64Codec();
        this.textDecoder = new TextDecoder();
    }

    public async getCoreAccessToken(
        authConfig: SalesforceAuthConfig,
        authParams: SalesforceConnectionParams,
        authCode: string,
        pkceVerifier: string,
        cancel: AbortSignal,
    ): Promise<SalesforceCoreAccessToken> {
        const params: Record<string, string> = {
            grant_type: 'authorization_code',
            code: authCode!,
            redirect_uri: authConfig.oauthRedirect.toString(),
            client_id: authParams.appConsumerKey,
            code_verifier: pkceVerifier,
            format: 'json',
        };
        if (authParams.appConsumerSecret) {
            params.client_secret = authParams.appConsumerSecret;
        }
        const body = new URLSearchParams(params);
        // Get the access token
        const response = await this.httpClient.fetch(new URL(`${authParams.instanceUrl}/services/oauth2/token`), {
            method: 'POST',
            headers: new Headers({
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            }),
            body: body,
            signal: cancel,
        });
        const responseBody = await response.json();
        if (responseBody.error) {
            const errorDesc = responseBody.error_description;
            this.logger.error(errorDesc, {}, LOG_CTX);
            throw new Error(errorDesc);
        } else {
            const parsed = readCoreAccessToken(responseBody);
            return parsed;
        }
    }

    protected readDataCloudAccessToken(obj: any): SalesforceDataCloudAccessToken {
        const prependProtoIfMissing = (urlString: string) => {
            if (!urlString.startsWith('https:')) {
                urlString = `https://${urlString}`;
            }
            return new URL(urlString);
        };
        if (!obj.access_token) {
            throw new Error('missing access_token');
        }
        if (!obj.instance_url) {
            throw new Error('missing instance_url');
        }

        const access_token = obj.access_token;
        const jwtParts = access_token.split('.');
        if (jwtParts.length != 3) {
            throw new Error(`invalid jwt, expected 3 parts, received ${jwtParts.length}`);
        }

        // Parse the JWT header
        const jwtHeaderRaw = jwtParts[0];
        const jwtHeaderBytes = this.base64Codec.decode(jwtHeaderRaw);
        const jwtHeaderText = this.textDecoder.decode(jwtHeaderBytes);
        const jwtHeaderParsed = JSON.parse(jwtHeaderText);

        // Parse the JWT payload
        const jwtPayloadRaw = jwtParts[1];
        const jwtPayloadBytes = this.base64Codec.decode(jwtPayloadRaw);
        const jwtPayloadText = this.textDecoder.decode(jwtPayloadBytes);
        const jwtPayloadParsed = JSON.parse(jwtPayloadText) as SalesforceDataCloudJWTPayload;

        const access = new SalesforceDataCloudAccessToken(
            obj.token_type ?? null,
            obj.issued_token_type ?? null,
            new Date(Number.parseInt(jwtPayloadParsed.exp) * 1000),
            {
                raw: access_token,
                header: jwtHeaderParsed,
                payload: jwtPayloadParsed
            },
            prependProtoIfMissing(obj.instance_url),
        );
        return access;
    }

    public async getDataCloudAccessToken(
        access: SalesforceCoreAccessToken,
        cancel: AbortSignal,
    ): Promise<SalesforceDataCloudAccessToken> {
        const params: Record<string, string> = {
            grant_type: 'urn:salesforce:grant-type:external:cdp',
            subject_token: access.accessToken!,
            subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            // dataspace: 'default'
        };
        const body = new URLSearchParams(params);
        // Get the data cloud access token
        const response = await this.httpClient.fetch(new URL(`${access.instanceUrl}/services/a360/token`), {
            method: 'POST',
            headers: new Headers({
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            }),
            body: body,
            signal: cancel,
        });
        const responseBody = await response.json();
        if (responseBody.error) {
            const err = responseBody as { error: string, error_description: string };
            throw new Error(`request failed: error=${err.error}, description=${err.error_description}`);
        }
        return this.readDataCloudAccessToken(responseBody);
    }

    public async getCoreUserInfo(access: SalesforceCoreAccessToken, cancel: AbortSignal): Promise<SalesforceUserInfo> {
        const params = new URLSearchParams();
        params.set('format', 'json');
        params.set('access_token', access.accessToken ?? '');
        const response = await this.httpClient.fetch(new URL(`${access.instanceUrl}/services/oauth2/userinfo?${params.toString()}`), {
            headers: {
                authorization: `Bearer ${access.accessToken}`,
                accept: 'application/json',
            },
            signal: cancel,
        });
        const responseJson = await response.json();
        return readUserInformation(responseJson);
    }

    public async getDataCloudMetadata(
        access: SalesforceDataCloudAccessToken,
        cancel: AbortSignal,
    ): Promise<SalesforceMetadata> {
        const response = await this.httpClient.fetch(new URL(`${access.instanceUrl.toString()}api/v1/metadata`), {
            headers: {
                authorization: `Bearer ${access.jwt.raw}`,
                accept: 'application/json',
            },
            signal: cancel,
        });
        const responseJson = await response.json();
        return responseJson as SalesforceMetadata;
    }
}

export class SalesforceDatabaseChannel implements HyperDatabaseChannel {
    /// The api client
    protected apiClient: SalesforceApiClientInterface;
    /// The core access token
    public readonly coreToken: SalesforceCoreAccessToken;
    /// The data cloud access token
    public readonly dataCloudToken: SalesforceDataCloudAccessToken;
    /// The Hyper database channel
    hyperChannel: HyperDatabaseChannel;

    /// The constructor
    constructor(apiClient: SalesforceApiClientInterface, coreToken: SalesforceCoreAccessToken, dataCloudToken: SalesforceDataCloudAccessToken, channel: HyperDatabaseChannel) {
        this.apiClient = apiClient;
        this.coreToken = coreToken;
        this.dataCloudToken = dataCloudToken;
        this.hyperChannel = channel;
    }

    /// Perform a health check
    async checkHealth(): Promise<HealthCheckResult> {
        return this.hyperChannel.checkHealth();
    }
    /// Execute Query
    async executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam, abort?: AbortSignal): Promise<HyperQueryResultStream> {
        return this.hyperChannel.executeQuery(param, abort);
    }
    /// Destroy the connection
    async close(): Promise<void> {
        return this.hyperChannel.close();
    }
}
