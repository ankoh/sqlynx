import * as pb from '@ankoh/dashql-protobuf';

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

export function encodeSalesforceConnectionParamsAsProto(params: SalesforceConnectionParams | null, settings: WorkbookExportSettings | null): pb.dashql.connection.ConnectionParams {
    return new pb.dashql.connection.ConnectionParams({
        connection: {
            case: "salesforce",
            value: new pb.dashql.connection.SalesforceConnectionParams({
                instanceUrl: params?.instanceUrl ?? "",
                appConsumerKey: params?.appConsumerKey ?? "",
                loginHint: settings?.exportUsername ? (params?.loginHint ?? undefined) : undefined,
            })
        }
    });
}

export function readSalesforceConnectionParamsFromProto(params: pb.dashql.connection.SalesforceConnectionParams): SalesforceConnectionParams {
    return {
        instanceUrl: params.instanceUrl,
        appConsumerKey: params.appConsumerKey,
        appConsumerSecret: "",
        loginHint: params.loginHint,
    };
}

