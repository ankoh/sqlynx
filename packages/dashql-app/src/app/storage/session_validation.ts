import type { SessionData, SessionEntry } from './storage_backend.js';
import { getConnectorInfoForParams, ConnectorType } from '../connections/connector_info.js';
import { SESSION_FORMAT_VERSION } from '../../migration/versions.js';

/// A syntactically valid UUID (any version), e.g. the output of `crypto.randomUUID()`.
///
/// Matched case-insensitively and deliberately not pinned to v4: the only requirement is the
/// canonical 8-4-4-4-12 hex shape, which is enough to treat the value as an authoritative session
/// key. Anything else (a legacy `opfs://sessions/<uuid>` path, a slug, an empty string) fails.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// Whether a string is a syntactically valid UUID.
export function isValidUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

/// Why a persisted session was rejected during validation.
///
/// These are *metadata* problems detected before any heavy restoration work runs. A session that
/// validates here may still hit non-fatal hiccups later (e.g. a catalog that fails to load), but
/// such hiccups never make the session "invalid" — they degrade gracefully as before.
export enum SessionValidationError {
    /// The session does not declare the current persistence format version.
    UnsupportedFormatVersion = 'unsupported_format_version',
    /// The session has no `sessionId`, or it is empty.
    MissingSessionId = 'missing_session_id',
    /// The `sessionId` is present but is not a syntactically valid UUID.
    InvalidSessionId = 'invalid_session_id',
    /// The connection list of the session is missing, empty or malformed.
    InvalidConnections = 'invalid_connections',
    /// A connection has no valid UUID `connectionId`, or the id is listed twice.
    InvalidConnectionId = 'invalid_connection_id',
    /// The default connection id does not reference a connection of the session.
    InvalidDefaultConnectionId = 'invalid_default_connection_id',
    /// A connection has no `params`.
    MissingConnectionParams = 'missing_connection_params',
    /// The connection `params` do not match any known connector.
    UnknownConnector = 'unknown_connector',
    /// The session is registered in the manifest but its files can't be read (e.g. a native session
    /// whose folder was moved or deleted on disk, or a corrupt/absent OPFS session). Unlike the
    /// errors above this is detected by an actual load failure rather than by inspecting metadata,
    /// but it lands in the same bucket: the session can't be opened and should be surfaced as invalid
    /// so the user can remove the stale entry.
    SessionUnreadable = 'session_unreadable',
}

/// A short, human-readable explanation for each validation error, shown in the session workbench.
export function describeSessionValidationError(error: SessionValidationError): string {
    switch (error) {
        case SessionValidationError.UnsupportedFormatVersion:
            return 'Unsupported session format version';
        case SessionValidationError.MissingSessionId:
            return 'Missing session id';
        case SessionValidationError.InvalidSessionId:
            return 'Invalid session id';
        case SessionValidationError.InvalidConnections:
            return 'Session must list at least one connection';
        case SessionValidationError.InvalidConnectionId:
            return 'Invalid connection id';
        case SessionValidationError.InvalidDefaultConnectionId:
            return 'Default connection must reference a connection of the session';
        case SessionValidationError.MissingConnectionParams:
            return 'Missing connection parameters';
        case SessionValidationError.UnknownConnector:
            return 'Unknown connector';
        case SessionValidationError.SessionUnreadable:
            return 'Session files missing';
    }
}

/// The result of validating a session's metadata.
export type SessionValidationResult =
    | { ok: true }
    | { ok: false; error: SessionValidationError };

/// Validate a session's metadata before loading it.
///
/// This is a fail-fast gate run up front in the loader: it rejects sessions whose metadata is
/// structurally unusable (unsupported format, no id, or an invalid connection).
/// It deliberately does NOT attempt the full connection decode — `getConnectorInfoForParams` is a
/// non-throwing connector probe, so a session that passes here can still be decoded by
/// `decodeConnectionFromProto` during restore.
export function validateSessionData(data: SessionData): SessionValidationResult {
    if ((data as { formatVersion?: unknown }).formatVersion !== SESSION_FORMAT_VERSION) {
        return { ok: false, error: SessionValidationError.UnsupportedFormatVersion };
    }
    if (!data.sessionId) {
        return { ok: false, error: SessionValidationError.MissingSessionId };
    }
    if (!isValidUuid(data.sessionId)) {
        return { ok: false, error: SessionValidationError.InvalidSessionId };
    }
    const connections: unknown = (data as { connections?: unknown }).connections;
    if (!Array.isArray(connections) || connections.length === 0) {
        return { ok: false, error: SessionValidationError.InvalidConnections };
    }
    const connectionIds = new Set<string>();
    for (const connection of connections as SessionData['connections']) {
        if (!connection || typeof connection.connectionId !== 'string' || !isValidUuid(connection.connectionId)
            || connectionIds.has(connection.connectionId)) {
            return { ok: false, error: SessionValidationError.InvalidConnectionId };
        }
        connectionIds.add(connection.connectionId);
        if (!connection.params) {
            return { ok: false, error: SessionValidationError.MissingConnectionParams };
        }
        if (getConnectorInfoForParams(connection.params as any) == null) {
            return { ok: false, error: SessionValidationError.UnknownConnector };
        }
        if (connection.paramsDraft != null && getConnectorInfoForParams(connection.paramsDraft as any)?.connectorType
            !== getConnectorInfoForParams(connection.params as any)?.connectorType) {
            return { ok: false, error: SessionValidationError.UnknownConnector };
        }
    }
    if (!connectionIds.has(data.defaultConnectionId)) {
        return { ok: false, error: SessionValidationError.InvalidDefaultConnectionId };
    }
    return { ok: true };
}

export function isLocalHyperWasmParams(params: SessionData['connections'][number]['params']): boolean {
    return 'hyper' in params && (params.hyper?.protocol ?? 'WASM') === 'WASM';
}

/// A session that failed metadata validation and was refused a load.
///
/// Carried out of the loader so the session workbench can surface it (marked invalid, blocked from
/// opening, still deletable). It holds just enough to render and to delete the session: the bare
/// UUID (the storage key), a best-effort title, a connector type for the icon when one could be
/// inferred, and the reason it was rejected.
export interface InvalidSession {
    /// The bare session UUID — the key used for routing and for `deleteSession`.
    sessionId: string;
    /// A best-effort display title (falls back to the display path / UUID).
    title: string;
    /// The connector type if it could be inferred from the params, else null.
    connectorType: ConnectorType | null;
    /// Why the session was rejected.
    error: SessionValidationError;
}

/// Build an `InvalidSession` record from whatever metadata is available.
///
/// `data` may be absent (e.g. the session file failed to load/parse entirely), in which case we
/// fall back to the manifest entry's path for the id and title.
export function describeInvalidSession(
    entry: SessionEntry,
    error: SessionValidationError,
    data: SessionData | null,
): InvalidSession {
    // The manifest entry's path is the authoritative registry key, so it is what `deleteSession`
    // must be handed to evict the session — not `data.sessionId`, which is exactly the field that
    // may be missing or malformed on an invalid session.
    const sessionId = entry.path;
    const params = Array.isArray(data?.connections)
        ? data.connections.find(connection => connection?.connectionId === data.defaultConnectionId)?.params
        : undefined;
    const connectorInfo = params
        ? getConnectorInfoForParams(params as any)
        : null;
    return {
        sessionId,
        title: data?.name || data?.sessionPath || sessionId,
        connectorType: connectorInfo?.connectorType ?? null,
        error,
    };
}
