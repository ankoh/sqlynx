import { describe, expect, it } from 'vitest';
import type * as connection from '@ankoh/dashql-jsonschema/connection.js';
import type { AttachedDatabaseState } from './attached_database_state.js';
import { SALESFORCE_DATA_CLOUD_CONNECTOR } from './connector_info.js';
import { checkSalesforceConnectionSetup, ConnectionSetupCheck } from './connector_setup_check.js';

describe('Salesforce connection setup check', () => {
    const params = { appConsumerKey: 'consumer-key' } as connection.SalesforceConnectionParams;

    it.each([
        { token: {}, error: undefined, expected: ConnectionSetupCheck.AUTHENTICATION_IN_PROGRESS },
        { token: {}, error: { message: 'OAuth failed' }, expected: ConnectionSetupCheck.AUTHENTICATION_FAILED },
        {
            token: { accessToken: 'org-jwt', jwt: { raw: 'org-jwt', payload: {} } },
            error: undefined,
            expected: ConnectionSetupCheck.AUTHENTICATED,
        },
    ])('requires a usable OrgJWT instead of a reducer placeholder', ({ token, error, expected }) => {
        const state = {
            details: {
                type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                value: {
                    proto: {
                        setupParams: params,
                        setupTimings: { authStartedAt: new Date(0).toISOString() },
                        setupError: error,
                        oauthState: { coreAccessToken: token },
                    },
                },
            },
        } as unknown as AttachedDatabaseState;
        expect(checkSalesforceConnectionSetup(state, params)).toBe(expected);
    });
});
