import { ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from "./connector_info.js";
import { VariantKind } from "../../utils/variant.js";
import { createHyperConnectionStateDetails, HyperConnectionDetails } from "./hyper/hyper_connection_state.js";
import { createSalesforceConnectionStateDetails, SalesforceConnectionStateDetails } from "./salesforce/salesforce_connection_state.js";
import { createTrinoConnectionStateDetails, TrinoConnectionStateDetails } from "./trino/trino_connection_state.js";

export type ConnectionStateDetailsVariant =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, SalesforceConnectionStateDetails>
    | VariantKind<typeof HYPER_CONNECTOR, HyperConnectionDetails>
    | VariantKind<typeof TRINO_CONNECTOR, TrinoConnectionStateDetails>
    ;

export function createConnectionStateDetails(type: ConnectorType): ConnectionStateDetailsVariant {
    switch (type) {
        case ConnectorType.TRINO:
            return {
                type: TRINO_CONNECTOR,
                value: createTrinoConnectionStateDetails(),
            };
        case ConnectorType.HYPER:
            return {
                type: HYPER_CONNECTOR,
                value: createHyperConnectionStateDetails(),
            };
        case ConnectorType.SALESFORCE_DATA_CLOUD:
            return {
                type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                value: createSalesforceConnectionStateDetails(),
            };
    }
}
