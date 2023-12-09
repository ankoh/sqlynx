import { sleep } from '../utils/sleep';
import {
    SalesforceAPIClientInterface,
    SalesforceCoreAccessToken,
    SalesforceDataCloudAccessToken,
    SalesforceMetadata,
    SalesforceUserInfo,
} from './salesforce_api_client';

import SalesforceDummyAccount from '../../static/img/salesforce_account_placeholder.png';

export class SalesforceAPIClientMock implements SalesforceAPIClientInterface {
    async getUserInfo(_access: SalesforceCoreAccessToken, _cancel: AbortSignal): Promise<SalesforceUserInfo> {
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
    public async getMetadata(
        _access: SalesforceDataCloudAccessToken,
        _cancel: AbortSignal,
    ): Promise<SalesforceMetadata> {
        await sleep(200);
        return {
            metadata: [],
        };
    }
}
