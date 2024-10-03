import * as proto from '@ankoh/sqlynx-protobuf';

export interface SalesforceAuthParams {
    /// The foundations URL
    instanceUrl: string;
    /// The client id
    appConsumerKey: string;
    /// The client secret
    appConsumerSecret: string | null;
    /// The login hint (if any)
    loginHint: string | null;
}

export function buildSalesforceConnectorParams(params: SalesforceAuthParams | null): proto.sqlynx_session.pb.ConnectorParams {
    return new proto.sqlynx_session.pb.ConnectorParams({
        connector: {
            case: "salesforce",
            value: new proto.sqlynx_session.pb.SalesforceConnectorParams({
                instanceUrl: params?.instanceUrl ?? "",
                appConsumerKey: params?.appConsumerKey ?? "",
                loginHint: params?.loginHint ?? undefined,
            })
        }
    });
}

