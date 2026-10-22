import type * as app_session from '@ankoh/dashql-jsonschema/app_session.js';

import type { ConnectorInfo } from '../connections/connector_info.js';

export type SessionSettings = app_session.SessionSettings;

/// The settings of a new session. Defaults depend on the connector of its main database.
export function createDefaultSessionSettings(connectorInfo: ConnectorInfo): SessionSettings {
    return {
        cacheQueryResults: connectorInfo.features.queryResultCaching,
    };
}

/// The settings of a persisted session.
/// Sessions written before settings existed get the defaults of a new session.
export function readSessionSettings(settings: Partial<SessionSettings> | undefined, connectorInfo: ConnectorInfo): SessionSettings {
    return { ...createDefaultSessionSettings(connectorInfo), ...settings };
}
