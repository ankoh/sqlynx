import * as proto from '@ankoh/sqlynx-pb';
import Immutable from 'immutable';

import { KeyValueListElement } from '../view/keyvalue_list.js';
import { GrpcChannelArgs } from '../platform/grpc_common.js';

export interface HyperGrpcConnectionParams {
    /// The gRPC endpoint
    channel: GrpcChannelArgs;
    /// The attached databases
    attachedDatabases: Immutable.List<KeyValueListElement>;
    /// The gRPC metadata
    gRPCMetadata: Immutable.List<KeyValueListElement>;
}

export interface SalesforceAuthParams {
    /// The base URL
    instanceUrl: string;
    /// The client id
    appConsumerKey: string;
    /// The client secret
    appConsumerSecret: string | null;
}

export function buildSalesforceConnectorParams(params: SalesforceAuthParams | null): proto.sqlynx_session.pb.ConnectorParams {
    return new proto.sqlynx_session.pb.ConnectorParams({
        connector: {
            case: "salesforce",
            value: new proto.sqlynx_session.pb.SalesforceConnectorParams({
                instanceUrl: params?.instanceUrl ?? "",
                appConsumerKey: params?.appConsumerKey ?? ""
            })
        }
    });
}

export function buildBrainstormConnectorParams(): proto.sqlynx_session.pb.ConnectorParams {
    return new proto.sqlynx_session.pb.ConnectorParams({
        connector: {
            case: "serverless",
            value: new proto.sqlynx_session.pb.ServerlessParams()
        }
    });
}

export function buildHyperConnectorParams(): proto.sqlynx_session.pb.ConnectorParams {
    return new proto.sqlynx_session.pb.ConnectorParams({
        connector: {
            case: "hyper",
            value: new proto.sqlynx_session.pb.HyperConnectorParams()
        }
    });
}
