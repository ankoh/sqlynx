import type { TrinoConnectionParams } from '../connection_params.js';

export function createTrinoConnectionParamsSignature(params: TrinoConnectionParams): any {
    return {
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
    };
}
