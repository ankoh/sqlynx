import { sleep } from '../utils/sleep';
import {
    SalesforceConnectorInterface,
    SalesforceCoreAccessToken,
    SalesforceDataCloudAccessToken,
    SalesforceMetadata,
    SalesforceUserInfo,
} from './salesforce_api_client';

import SalesforceDummyAccount from '../../static/img/salesforce_account_placeholder.png';
import { SalesforceAuthParams } from './salesforce_auth_state';

export class SalesforceAPIClientMock implements SalesforceConnectorInterface {
    public async getCoreAccessToken(
        _authParams: SalesforceAuthParams,
        _authCode: string,
        _pkceVerifier: string,
        _cancel: AbortSignal,
    ): Promise<SalesforceCoreAccessToken> {
        await sleep(200);
        return {
            accessToken: 'core-access-token',
            apiInstanceUrl: 'https://localhost',
            id: 'core-access-id',
            idToken: 'core-access-id-token',
            instanceUrl: 'core-access-instance-url',
            issuedAt: 'core-access-issued-at',
            refreshToken: 'core-access-refresh-token',
            scope: 'core-access-scope',
            signature: 'core-access-signature',
            tokenType: 'core-access-token-type',
        };
    }

    async getCoreUserInfo(_access: SalesforceCoreAccessToken, _cancel: AbortSignal): Promise<SalesforceUserInfo> {
        await sleep(200);
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

    public async getDataCloudAccessToken(
        _access: SalesforceCoreAccessToken,
        _cancel: AbortSignal,
    ): Promise<SalesforceDataCloudAccessToken> {
        await sleep(200);
        const expiresAt = new Date();
        expiresAt.setSeconds(expiresAt.getSeconds() + 7200);
        return {
            accessToken: 'data-cloud-access-token',
            instanceUrl: new URL('http://localhost'),
            expiresAt: expiresAt,
            issuedTokenType: 'data-cloud-issued-token-type',
            tokenType: 'data-cloud-token-type',
        };
    }

    public async getDataCloudMetadata(
        _access: SalesforceDataCloudAccessToken,
        _cancel: AbortSignal,
    ): Promise<SalesforceMetadata> {
        await sleep(200);
        return {
            metadata: [],
        };
    }
}
