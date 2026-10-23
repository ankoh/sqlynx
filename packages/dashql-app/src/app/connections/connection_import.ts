import * as dashql from '@ankoh/dashql-core';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { ConnectionStateDetailsVariant } from './connection_state_details.js';
import { LoggableException } from '../../platform/logger/logger.js';
import { CONNECTOR_INFOS, ConnectorInfo, ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from './connector_info.js';
import { ConnectionState, createConnectionState } from './connection_state.js';
import type { ConnectionParams } from './connection_params.js';
const LOG_CTX = "connection";

export function decodeConnectionFromProto(conn: connection.Connection, sessionId: string): [ConnectorInfo, ConnectionStateDetailsVariant] {
    if ('salesforce' in conn) {
        const info: ConnectorInfo = CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD];
        // Storage persists ConnectionParams (flat SalesforceConnectionParams),
        // not the Details wrapper. Normalize so proto.setupParams is populated.
        const sf = conn.salesforce as any;
        const proto = sf?.setupParams
            ? sf
            : { setupTimings: {}, setupParams: sf ?? {} };
        const details: ConnectionStateDetailsVariant = {
            type: SALESFORCE_DATA_CLOUD_CONNECTOR,
            value: {
                proto,
                channel: null,
            }
        };
        return [info, details];
    } else if ('hyper' in conn) {
        const info: ConnectorInfo = CONNECTOR_INFOS[ConnectorType.HYPER];
        const hy = conn.hyper as any;
        const proto = hy?.setupParams
            ? hy
            : { setupTimings: {}, setupParams: hy ?? {} };
        const details: ConnectionStateDetailsVariant = {
            type: HYPER_CONNECTOR,
            value: {
                proto,
                channel: null,
            }
        };
        return [info, details];
    } else if ('trino' in conn) {
        const info: ConnectorInfo = CONNECTOR_INFOS[ConnectorType.TRINO];
        const tr = conn.trino as any;
        const proto = tr?.setupParams
            ? tr
            : { setupTimings: {}, setupParams: tr ?? {} };
        const details: ConnectionStateDetailsVariant = {
            type: TRINO_CONNECTOR,
            value: {
                proto,
                channel: null,
            }
        };
        return [info, details];
    } else {
        throw new LoggableException("unsupported connection details", { sessionId }, LOG_CTX);
    }
}

export function restoreConnectionState(instance: dashql.DashQL, connectionId: string, info: ConnectorInfo, details: ConnectionStateDetailsVariant, paramsDraft?: ConnectionParams, name?: string): ConnectionState {
    return { ...createConnectionState(instance, info, details, { active: true, paramsDraft, name }), connectionId };
}
