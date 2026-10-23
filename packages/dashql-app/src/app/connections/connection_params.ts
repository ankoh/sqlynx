import * as dashql from '@ankoh/dashql-core';
import type * as app_session from '@ankoh/dashql-jsonschema/app_session.js';

import { CONNECTOR_INFOS, ConnectorType, ConnectorInfo } from './connector_info.js';
import { ConnectionStateWithoutId, createConnectionState } from './connection_state.js';
import { ConnectionStateDetailsVariant } from './connection_state_details.js';
import { CONNECTOR_DESCRIPTORS, connectionParamsOf, connectionStateDetailsOf, connectorOfDetails, connectorOfParams, connectorParams } from './connector_descriptor.js';

// Re-export connection param types from JSON Schema
export type ConnectionParams = app_session.ConnectionParams;
export type HyperConnectionParams = app_session.HyperConnectionParams;
export type SalesforceConnectionParams = app_session.SalesforceConnectionParams;
export type TrinoConnectionParams = app_session.TrinoConnectionParams;

/// Raw form rows belong only to the local draft, never to committed/runtime parameters.
export function connectionParamsWithoutDraftRows(params: ConnectionParams): ConnectionParams {
    const connector = connectorOfParams(params);
    return connectionParamsOf(connector, connector.withoutDraftRows(connectorParams(connector, params)));
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

export function getConnectionStateDetailsFromParams(params: ConnectionParams): ConnectionStateDetailsVariant {
    const connector = connectorOfParams(params);
    return connectionStateDetailsOf(connector, connectorParams(connector, params));
}

export function getConnectionParamsFromStateDetails(details: ConnectionStateDetailsVariant): ConnectionParams | null {
    const setupParams = details.value.proto.setupParams;
    return setupParams ? connectionParamsOf(connectorOfDetails(details), setupParams) : null;
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
    const connector = connectorOfParams(params);
    const withoutDraftRows = connector.withoutDraftRows(connectorParams(connector, params));
    return connectionParamsOf(connector, connector.sanitizeForSharing(withoutDraftRows, withLoginHint));
}

/// Whether the connection params carry a login hint (the resolved account username / login) that
/// could be shared. Used to decide if the "share login hint" toggle should be offered at all.
export function connectionParamsHaveLoginHint(params: ConnectionParams | null): boolean {
    if (!params) return false;
    const connector = connectorOfParams(params);
    return connector.loginHint(connectorParams(connector, params)) != null;
}

/// The params that identify the results of a query in the query result cache
export function createConnectionParamsSignature(params: ConnectionParams): unknown {
    const connector = connectorOfParams(params);
    return connector.cacheSignature(connectorParams(connector, params));
}

export function createConnectionStateFromParams(dql: dashql.DashQL, params: ConnectionParams): ConnectionStateWithoutId {
    return createConnectionState(dql, connectorOfParams(params).info, getConnectionStateDetailsFromParams(params), { params });
}

export function createDefaultHyperWasmConnectionState(dql: dashql.DashQL): ConnectionStateWithoutId {
    const connector = CONNECTOR_INFOS[ConnectorType.HYPER];
    return createConnectionStateFromParams(dql, createDefaultConnectionParamsForConnector(connector));
}

export function createDefaultConnectionParamsForConnector(info: ConnectorInfo): ConnectionParams {
    const connector = CONNECTOR_DESCRIPTORS[info.connectorType];
    return connectionParamsOf(connector, connector.defaultParams());
}
