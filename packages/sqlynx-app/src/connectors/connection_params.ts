import { ConnectionDetailsVariant } from './connection_state.js';
import { DEMO_CONNECTOR, HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, SERVERLESS_CONNECTOR } from './connector_info.js';
import { buildServerlessConnectorParams } from './serverless/serverless_connection_params.js';
import { buildDemoConnectorParams } from './demo/demo_connection_params.js';
import { buildHyperConnectorParams } from './hyper/hyper_connection_params.js';
import { buildSalesforceConnectorParams } from './salesforce/salesforce_connection_params.js';


export function buildConnectorParams(state: ConnectionDetailsVariant) {
    switch (state.type) {
        case SERVERLESS_CONNECTOR:
            return buildServerlessConnectorParams();
        case DEMO_CONNECTOR:
            return buildDemoConnectorParams();
        case HYPER_GRPC_CONNECTOR: {
            if (state.value.channelSetupParams == null) {
                return null;
            } else {
                return buildHyperConnectorParams(state.value.channelSetupParams);
            }
        }
        case SALESFORCE_DATA_CLOUD_CONNECTOR: {
            return buildSalesforceConnectorParams(state.value.authParams);
        }
    }
}
