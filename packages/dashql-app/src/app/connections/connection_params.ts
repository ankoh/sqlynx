import * as dashql from '@ankoh/dashql-core';
import type * as app_session from '@ankoh/dashql-jsonschema/app_session.js';

import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR, ConnectorInfo } from './connector_info.js';
import { ConnectionHealth, ConnectionStateWithoutId, ConnectionStatus, createConnectionMetrics } from './connection_state.js';
import { computeNewConnectionSignatureFromDetails, ConnectionStateDetailsVariant } from './connection_state_details.js';
import { createHyperConnectionParamsSignature } from './hyper/hyper_connection_params.js';
import { createHyperConnectionStateDetails } from './hyper/hyper_connection_state.js';
import { createSalesforceConnectionParamsSignature } from './salesforce/salesforce_connection_params.js';
import { createSalesforceConnectionStateDetails } from './salesforce/salesforce_connection_state.js';
import { createTrinoConnectionParamsSignature } from './trino/trino_connection_params.js';
import { createTrinoConnectionStateDetails } from './trino/trino_connection_state.js';
import { newConnectionSignature, ConnectionSignatureMap } from './connection_signature.js';
import { generateCatalogScriptHeader, CatalogSource } from './catalog_sql_generator.js';
import { generateFunctionScriptHeader } from './catalog_function_sql_generator.js';

// Re-export connection param types from JSON Schema
export type ConnectionParams = app_session.ConnectionParams;
export type HyperConnectionParams = app_session.HyperConnectionParams;
export type SalesforceConnectionParams = app_session.SalesforceConnectionParams;
export type TrinoConnectionParams = app_session.TrinoConnectionParams;

/// Raw form rows belong only to the local draft, never to committed/runtime parameters.
export function connectionParamsWithoutDraftRows(params: ConnectionParams): ConnectionParams {
    if ('hyper' in params) {
        const { draftRows: _rows, ...hyper } = params.hyper;
        return { hyper };
    }
    if ('trino' in params) {
        const { draftRows: _rows, ...trino } = params.trino;
        return { trino };
    }
    return params;
}

/// A canonical encoding of connection params that doesn't depend on the order of object keys
export function connectionParamsKey(params: ConnectionParams | undefined): string {
    return JSON.stringify(params, (_key, value) =>
        value != null && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value) ?? '';
}

export function connectionParamsEqual(left: ConnectionParams | undefined, right: ConnectionParams | undefined): boolean {
    return connectionParamsKey(left) === connectionParamsKey(right);
}

/// Do two params describe the same connection, ignoring everything that sharing strips?
/// Shared sessions carry sanitized params without secrets and login hints, they still describe the
/// connection a local session uses with the full params.
export function connectionParamsShareEqual(left: ConnectionParams, right: ConnectionParams): boolean {
    return connectionParamsEqual(sanitizeConnectionParamsForSharing(left, false), sanitizeConnectionParamsForSharing(right, false));
}

/// Do the relations of a connection outlive the app?
/// The embedded HyperDB-WASM database is created anew with every page load, so its relations and the
/// catalog changes of executed statements are neither persisted nor restored. Its functions are the
/// builtins of Hyper and stay persisted.
export function connectionCatalogIsDurable(params: ConnectionParams): boolean {
    return !('hyper' in params && params.hyper.protocol === 'WASM');
}

export function getConnectionInfoFromParams(params: ConnectionParams) {
    if ('trino' in params) return CONNECTOR_INFOS[ConnectorType.TRINO];
    if ('hyper' in params) return CONNECTOR_INFOS[ConnectorType.HYPER];
    if ('salesforce' in params) return CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD];
    return undefined;
}

export function getConnectionStateDetailsFromParams(params: ConnectionParams): ConnectionStateDetailsVariant | null {
    if ('trino' in params) return { type: TRINO_CONNECTOR, value: createTrinoConnectionStateDetails(params.trino as any) };
    if ('hyper' in params) return { type: HYPER_CONNECTOR, value: createHyperConnectionStateDetails(params.hyper as any) };
    if ('salesforce' in params) return { type: SALESFORCE_DATA_CLOUD_CONNECTOR, value: createSalesforceConnectionStateDetails(params.salesforce as any) };
    return null;
}

export function getConnectionParamsFromStateDetails(params: ConnectionStateDetailsVariant): ConnectionParams | null {
    switch (params.type) {
        case TRINO_CONNECTOR:
            if (!params.value.proto.setupParams) return null;
            return { trino: params.value.proto.setupParams };
        case HYPER_CONNECTOR:
            if (!params.value.proto.setupParams) return null;
            return { hyper: params.value.proto.setupParams };
        case SALESFORCE_DATA_CLOUD_CONNECTOR:
            if (!params.value.proto.setupParams) return null;
            return { salesforce: params.value.proto.setupParams };
    }
}

/// Strip sensitive credentials from connection params before they are encoded into a shared
/// link or file. Identity/hint fields (instance urls, consumer keys, usernames, login hints)
/// are preserved so a recipient can be prompted with a prefilled sign-in, but no secret that
/// would grant access on its own is included. This is always applied when connection info is
/// shared — sharing raw secrets is never intended.
///
/// The login hint (the resolved account username / login) identifies the sharer personally, so
/// it is only carried when `withLoginHint` is true. When false it is cleared while the rest of
/// the (non-secret) connection identity is preserved.
export function sanitizeConnectionParamsForSharing(params: ConnectionParams, withLoginHint: boolean = true): ConnectionParams {
    params = connectionParamsWithoutDraftRows(params);
    if ('salesforce' in params && params.salesforce) {
        // Keep instanceUrl, appConsumerKey and the login hint; drop the connected-app secret.
        return { salesforce: { ...params.salesforce, appConsumerSecret: "", ...(withLoginHint ? {} : { login: "" }) } };
    }
    if ('trino' in params && params.trino) {
        // Keep endpoint, catalog and the basic-auth username; drop the basic-auth secret /
        // access token. OAuth params (client id + urls) carry no secret and are left as-is.
        // The basic-auth username doubles as the login hint here.
        // Arbitrary request headers may carry credentials under any name.
        const { metadata: _metadata, ...trino } = params.trino;
        return {
            trino: {
                ...trino,
                auth: {
                    ...trino.auth,
                    ...(trino.auth?.basic ? { basic: { ...trino.auth.basic, secret: "", ...(withLoginHint ? {} : { username: "" }) } } : {}),
                },
            },
        };
    }
    if ('hyper' in params && params.hyper) {
        // Arbitrary headers and query parameters may carry credentials under any name.
        const { metadata: _metadata, queryParameters: _queryParameters, ...hyper } = params.hyper;
        return {
            hyper: {
                ...hyper,
                tls: { clientKeyPath: "", clientCertPath: "", caCertsPath: "" },
            },
        };
    }
    return params;
}

/// Whether the connection params carry a login hint (the resolved account username / login) that
/// could be shared. Used to decide if the "share login hint" toggle should be offered at all.
export function connectionParamsHaveLoginHint(params: ConnectionParams | null): boolean {
    if (!params) return false;
    if ('salesforce' in params && params.salesforce) {
        return !!params.salesforce.login;
    }
    if ('trino' in params && params.trino) {
        return !!params.trino.auth?.basic?.username;
    }
    return false;
}

export function createConnectionParamsSignature(params: ConnectionParams): any {
    if ('trino' in params) return createTrinoConnectionParamsSignature(params.trino);
    if ('hyper' in params) return createHyperConnectionParamsSignature(params.hyper);
    if ('salesforce' in params) return createSalesforceConnectionParamsSignature(params.salesforce);
    return null;
}

export function createConnectionStateFromParams(dql: dashql.DashQL, params: ConnectionParams, connSigs: ConnectionSignatureMap): ConnectionStateWithoutId {
    const info = getConnectionInfoFromParams(params)!;
    const details = getConnectionStateDetailsFromParams(params)!;
    const sig = computeNewConnectionSignatureFromDetails(details);

    const catalog = dql.createCatalog();
    const catalogRelationScript = dql.createScript(catalog);
    catalogRelationScript.replaceText(generateCatalogScriptHeader(CatalogSource.Unknown));
    const catalogFunctionScript = dql.createScript(catalog);
    catalogFunctionScript.replaceText(generateFunctionScriptHeader(CatalogSource.Unknown));
    return {
        instance: dql,
        active: false,
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        connectorInfo: info,
        connectionSignature: newConnectionSignature(sig, connSigs, null),
        metrics: createConnectionMetrics(),
        details,
        params: structuredClone(params),
        catalog,
        catalogUpdates: {
            tasksRunning: new Map(),
            tasksFinished: new Map(),
            currentFullRefresh: null,
            lastFullRefresh: null,
            restoredAt: null,
        },
        catalogRelationScript,
        catalogFunctionScript,
        catalogChangesSql: '',
        snapshotQueriesActiveFinished: 1,
        queriesActive: new Map(),
        queriesActiveOrdered: [],
        queriesFinished: new Map(),
        queriesFinishedOrdered: [],
    };
}

export function createDefaultHyperWasmConnectionState(
    dql: dashql.DashQL,
    connSigs: ConnectionSignatureMap,
): ConnectionStateWithoutId {
    const connector = CONNECTOR_INFOS[ConnectorType.HYPER];
    return createConnectionStateFromParams(
        dql,
        createDefaultConnectionParamsForConnector(connector),
        connSigs,
    );
}

export function createDefaultConnectionParamsForConnector(connector: ConnectorInfo): ConnectionParams {
    switch (connector.connectorType) {
        case ConnectorType.HYPER:
            return { hyper: { protocol: 'WASM', endpoint: '', tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' } } };
        case ConnectorType.SALESFORCE_DATA_CLOUD:
            return { salesforce: { hyperProtocol: 'V3_HTTP', instanceUrl: '', appConsumerKey: '', appConsumerSecret: '', login: '' } };
        case ConnectorType.TRINO:
            return { trino: { endpoint: '', catalogName: '', auth: { authType: 'AUTH_BASIC' } } };
    }
}
