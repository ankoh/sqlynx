import * as proto from '@ankoh/sqlynx-protobuf';

export interface SalesforceConnectionParams {
    /// The foundations URL
    instanceUrl: string;
    /// The client id
    appConsumerKey: string;
    /// The client secret
    appConsumerSecret: string | null;
    /// The login hint (if any)
    loginHint: string | null;
}

export function buildSalesforceConnectorParams(params: SalesforceConnectionParams | null): proto.sqlynx_workbook.pb.ConnectorParams {
    return new proto.sqlynx_workbook.pb.ConnectorParams({
        connector: {
            case: "salesforce",
            value: new proto.sqlynx_workbook.pb.SalesforceConnectorParams({
                instanceUrl: params?.instanceUrl ?? "",
                appConsumerKey: params?.appConsumerKey ?? "",
                loginHint: params?.loginHint ?? undefined,
            })
        }
    });
}

