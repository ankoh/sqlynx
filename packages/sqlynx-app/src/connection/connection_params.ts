import * as proto from '@ankoh/sqlynx-protobuf';

import { ConnectionDetailsVariant } from './connection_state.js';
import { DEMO_CONNECTOR, HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, SERVERLESS_CONNECTOR, TRINO_CONNECTOR } from './connector_info.js';
import { buildServerlessConnectionParams } from './serverless/serverless_connection_params.js';
import { buildDemoConnectionParams } from './demo/demo_connection_params.js';
import { buildHyperConnectionParams, HyperGrpcConnectionParams, readHyperConnectionParams } from './hyper/hyper_connection_params.js';
import { buildSalesforceConnectionParams, readSalesforceConnectionParams, SalesforceConnectionParams } from './salesforce/salesforce_connection_params.js';
import { buildTrinoConnectionParams, readTrinoConnectionParams, TrinoConnectionParams } from './trino/trino_connection_params.js';
import { VariantKind } from '../utils/variant.js';
import { WorkbookExportSettings } from 'workbook/workbook_export_settings.js';

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

export function encodeConnectionParams(state: ConnectionParamsVariant, settings: WorkbookExportSettings | null = null) {
    switch (state.type) {
        case SERVERLESS_CONNECTOR:
            return buildServerlessConnectionParams(settings);
        case DEMO_CONNECTOR:
            return buildDemoConnectionParams(settings);
        case TRINO_CONNECTOR:
            return buildTrinoConnectionParams(state.value, settings);
        case HYPER_GRPC_CONNECTOR:
            return buildHyperConnectionParams(state.value, settings);
        case SALESFORCE_DATA_CLOUD_CONNECTOR:
            return buildSalesforceConnectionParams(state.value, settings);
    }
}

export function readConnectionParamsFromProto(pb: proto.sqlynx_connection.pb.ConnectionParams): ConnectionParamsVariant | null {
    switch (pb.connection.case) {
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
                value: readSalesforceConnectionParams(pb.connection.value)
            }
        case "hyper":
            return {
                type: HYPER_GRPC_CONNECTOR,
                value: readHyperConnectionParams(pb.connection.value)
            }
        case "trino":
            return {
                type: TRINO_CONNECTOR,
                value: readTrinoConnectionParams(pb.connection.value)
            }
    }
    return null;
}
