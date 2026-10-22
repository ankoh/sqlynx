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
            token: { jwt: { raw: 'data-cloud-jwt', payload: {} } },
            error: undefined,
            expected: ConnectionSetupCheck.AUTHENTICATED,
        },
        {
            token: { jwt: { raw: 'data-cloud-jwt', payload: {} } },
            error: { message: 'Setup failed after exchange' },
            expected: ConnectionSetupCheck.AUTHENTICATION_FAILED,
        },
    ])('requires an exchanged token and gives setup errors precedence', ({ token, error, expected }) => {
        const state = {
            details: {
                type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                value: {
                    proto: {
                        setupParams: params,
                        setupTimings: { authStartedAt: new Date(0).toISOString() },
                        setupError: error,
                        oauthState: { coreAccessToken: { accessToken: 'opaque-core-token' }, dataCloudAccessToken: token },
                    },
                },
            },
        } as unknown as AttachedDatabaseState;
        expect(checkSalesforceConnectionSetup(state, params)).toBe(expected);
    });
});
