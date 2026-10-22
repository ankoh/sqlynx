import { ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from "./connector_info.js";
import { VariantKind } from "../../../utils/variant.js";
import { computeHyperConnectionSignature, createHyperConnectionStateDetails, HyperConnectionDetails } from "./hyper/hyper_connection_state.js";
import { computeSalesforceConnectionSignature, createSalesforceConnectionStateDetails, SalesforceConnectionStateDetails } from "./salesforce/salesforce_connection_state.js";
import { computeTrinoConnectionSignature, createTrinoConnectionStateDetails, TrinoConnectionStateDetails } from "./trino/trino_connection_state.js";
import { Hasher } from "../../../utils/hash.js";
import { DefaultHasher } from "../../../utils/hash_default.js";

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

export function computeConnectionSignatureFromDetails(state: ConnectionStateDetailsVariant, hasher: Hasher) {
    switch (state.type) {
        case TRINO_CONNECTOR:
            return computeTrinoConnectionSignature(state.value, hasher);
        case HYPER_CONNECTOR:
            return computeHyperConnectionSignature(state.value, hasher);
        case SALESFORCE_DATA_CLOUD_CONNECTOR:
            return computeSalesforceConnectionSignature(state.value, hasher);
    }
}

export function computeNewConnectionSignatureFromDetails(state: ConnectionStateDetailsVariant): Hasher {
    const sig = new DefaultHasher();
    computeConnectionSignatureFromDetails(state, sig);
    return sig;
}
