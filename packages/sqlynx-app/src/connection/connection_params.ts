import * as proto from '@ankoh/sqlynx-protobuf';

import { ConnectionDetailsVariant } from './connection_state.js';
import { DEMO_CONNECTOR, HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, SERVERLESS_CONNECTOR, TRINO_CONNECTOR } from './connector_info.js';
import { buildServerlessConnectorParams } from './serverless/serverless_connection_params.js';
import { buildDemoConnectorParams } from './demo/demo_connection_params.js';
import { buildHyperConnectorParams, HyperGrpcConnectionParams, readHyperConnectorParams } from './hyper/hyper_connection_params.js';
import { buildSalesforceConnectorParams, readSalesforceConnectorParams, SalesforceConnectionParams } from './salesforce/salesforce_connection_params.js';
import { buildTrinoConnectorParams, readTrinoConnectorParams, TrinoConnectionParams } from './trino/trino_connection_params.js';
import { VariantKind } from '../utils/variant.js';

export type ConnectionParamsVariant =
    | VariantKind<typeof SERVERLESS_CONNECTOR, {}>
    | VariantKind<typeof DEMO_CONNECTOR, {}>
    | VariantKind<typeof TRINO_CONNECTOR, TrinoConnectionParams>
    | VariantKind<typeof HYPER_GRPC_CONNECTOR, HyperGrpcConnectionParams>
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, SalesforceConnectionParams>;

export function getConnectionParamsFromDetails(state: ConnectionDetailsVariant): ConnectionParamsVariant | null {
    switch (state.type) {
        case SERVERLESS_CONNECTOR:
            return {
                type: SERVERLESS_CONNECTOR,
                value: {},
            }
        case DEMO_CONNECTOR:
            return {
                type: DEMO_CONNECTOR,
                value: {},
            };
        case TRINO_CONNECTOR:
            if (state.value.channelParams == null) {
                return null;
            }
            return {
                type: TRINO_CONNECTOR,
                value: state.value.channelParams,
            };
        case HYPER_GRPC_CONNECTOR: {
            if (state.value.channelSetupParams == null) {
                return null;
            }
            return {
                type: HYPER_GRPC_CONNECTOR,
                value: state.value.channelSetupParams
            };
        }
        case SALESFORCE_DATA_CLOUD_CONNECTOR: {
            if (state.value.setupParams == null) {
                return null;
            }
            return {
                type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                value: state.value.setupParams
            };
        }
    }
}

export function encodeConnectionParams(state: ConnectionParamsVariant) {
    switch (state.type) {
        case SERVERLESS_CONNECTOR:
            return buildServerlessConnectorParams();
        case DEMO_CONNECTOR:
            return buildDemoConnectorParams();
        case TRINO_CONNECTOR:
            return buildTrinoConnectorParams(state.value);
        case HYPER_GRPC_CONNECTOR:
            return buildHyperConnectorParams(state.value);
        case SALESFORCE_DATA_CLOUD_CONNECTOR:
            return buildSalesforceConnectorParams(state.value);
    }
}

export function readConnectionParamsFromProto(pb: proto.sqlynx_workbook.pb.ConnectorParams): ConnectionParamsVariant | null {
    switch (pb.connector.case) {
        case "serverless":
            return {
                type: SERVERLESS_CONNECTOR,
                value: {},
            }
        case "demo":
            return {
                type: DEMO_CONNECTOR,
                value: {},
            }
        case "salesforce":
            return {
                type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                value: readSalesforceConnectorParams(pb.connector.value)
            }
        case "hyper":
            return {
                type: HYPER_GRPC_CONNECTOR,
                value: readHyperConnectorParams(pb.connector.value)
            }
        case "trino":
            return {
                type: TRINO_CONNECTOR,
                value: readTrinoConnectorParams(pb.connector.value)
            }
    }
    return null;
}
