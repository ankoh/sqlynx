import * as dashql from '@ankoh/dashql-core';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { ConnectionStateDetailsVariant } from './connection_state_details.js';
import { LoggableException } from '../../platform/logger/logger.js';
import { CONNECTOR_INFOS, ConnectorInfo, ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from './connector_info.js';
import { ConnectionHealth, ConnectionState, ConnectionStatus, createConnectionMetrics, normalizeConnectionName } from './connection_state.js';
import { generateCatalogScriptHeader, CatalogSource } from './catalog_sql_generator.js';
import { generateFunctionScriptHeader } from './catalog_function_sql_generator.js';
import { QueryExecutionState } from './query_execution_state.js';
import { getConnectionParamsFromStateDetails, type ConnectionParams } from './connection_params.js';
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
    let catalog: ReturnType<dashql.DashQL['createCatalog']> | null = null;
    let catalogRelationScript: ReturnType<dashql.DashQL['createScript']> | null = null;
    let catalogFunctionScript: ReturnType<dashql.DashQL['createScript']> | null = null;
    try {
        catalog = instance.createCatalog();
        catalogRelationScript = instance.createScript(catalog);
        catalogRelationScript.replaceText(generateCatalogScriptHeader(CatalogSource.Unknown));
        catalogFunctionScript = instance.createScript(catalog);
        catalogFunctionScript.replaceText(generateFunctionScriptHeader(CatalogSource.Unknown));
    } catch (error) {
        catalogFunctionScript?.destroy();
        catalogRelationScript?.destroy();
        catalog?.destroy();
        throw error;
    }
    const restoredCatalog = catalog;
    const restoredCatalogRelationScript = catalogRelationScript;
    const restoredCatalogFunctionScript = catalogFunctionScript;

    const state: ConnectionState = {
        connectionId: connectionId,
        instance,
        active: true,
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        connectorInfo: info,
        details: details,
        params: getConnectionParamsFromStateDetails(details)!,
        paramsDraft: paramsDraft == null ? undefined : structuredClone(paramsDraft),
        name: normalizeConnectionName(name),
        metrics: createConnectionMetrics(),
        catalog: restoredCatalog,
        catalogUpdates: {
            tasksRunning: new Map(),
            tasksFinished: new Map(),
            currentFullRefresh: null,
            lastFullRefresh: null,
            restoredAt: null,
        },
        catalogRelationScript: restoredCatalogRelationScript,
        catalogFunctionScript: restoredCatalogFunctionScript,
        catalogChangesSql: '',
        queriesActive: new Map(),
        queriesActiveOrdered: [],
        queriesFinished: new Map<number, QueryExecutionState>(),
        queriesFinishedOrdered: [],
        snapshotQueriesActiveFinished: 0,
    };
    return state;
}
