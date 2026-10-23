import type { ConnectorDescriptor } from '../connector_descriptor.js';
import { CONNECTOR_INFOS, ConnectorType, TRINO_CONNECTOR } from '../connector_info.js';
import { createTrinoConnectionStateDetails, reduceTrinoConnectorState } from './trino_connection_state.js';

/// Trino connections
export const TRINO_CONNECTOR_DESCRIPTOR: ConnectorDescriptor<'trino'> = {
    info: CONNECTOR_INFOS[ConnectorType.TRINO],
    paramsKey: 'trino',
    detailsType: TRINO_CONNECTOR,
    defaultParams: () => ({ endpoint: '', catalogName: '', auth: { authType: 'AUTH_BASIC' } }),
    createDetails: createTrinoConnectionStateDetails,
    reduce: reduceTrinoConnectorState,
    withoutDraftRows: ({ draftRows: _rows, ...params }) => params,
    sanitizeForSharing(params, withLoginHint) {
        // Keep endpoint, catalog and the basic-auth username; drop the basic-auth secret /
        // access token. OAuth params (client id + urls) carry no secret and are left as-is.
        // The basic-auth username doubles as the login hint here.
        // Arbitrary request headers may carry credentials under any name.
        const { metadata: _metadata, ...trino } = params;
        return {
            ...trino,
            auth: {
                ...trino.auth,
                ...(trino.auth?.basic ? { basic: { ...trino.auth.basic, secret: "", ...(withLoginHint ? {} : { username: "" }) } } : {}),
            },
        };
    },
    loginHint: params => params.auth?.basic?.username || null,
    cacheSignature: params => ({
        case: "trino",
        endpoint: params.endpoint,
        auth: {
            authType: params.auth?.authType,
            basicUsername: params.auth?.basic?.username,
            oauthAuthUrl: params.auth?.oauth?.authorizationUrl,
            oauthTokenUrl: params.auth?.oauth?.tokenUrl,
            oauthRedirectUrl: params.auth?.oauth?.callbackUrl,
            oauthClientId: params.auth?.oauth?.clientId,
            oauthScopes: params.auth?.oauth?.scopes,
        },
        catalog: params.catalogName,
        schemas: (params.schemaNames || []).sort((a: string, b: string) => a > b ? 1 : -1)
    }),
    // Queries name the catalog but no schema, the server rejects relations without a schema
    catalogNameDefaults: details => ({ databaseName: details.proto.setupParams?.catalogName ?? '', schemaName: '' }),
};
