import * as proto from '@ankoh/sqlynx-protobuf';

import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';

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

export function buildSalesforceConnectionParams(params: SalesforceConnectionParams | null, settings: WorkbookExportSettings | null): proto.sqlynx_connection.pb.ConnectionParams {
    return new proto.sqlynx_connection.pb.ConnectionParams({
        connection: {
            case: "salesforce",
            value: new proto.sqlynx_connection.pb.SalesforceConnectionParams({
                instanceUrl: params?.instanceUrl ?? "",
                appConsumerKey: params?.appConsumerKey ?? "",
                loginHint: settings?.exportUsername ? (params?.loginHint ?? undefined) : undefined,
            })
        }
    });
}

export function readSalesforceConnectionParams(params: proto.sqlynx_connection.pb.SalesforceConnectionParams): SalesforceConnectionParams {
    return {
        instanceUrl: params.instanceUrl,
        appConsumerKey: params.appConsumerKey,
        appConsumerSecret: "",
        loginHint: params.loginHint,
    };
}

