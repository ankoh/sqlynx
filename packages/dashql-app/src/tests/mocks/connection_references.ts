import type { ConnectionReferences } from '../../app/connections/connection_registry.js';

/// The references of sessions that use fixed connections (sessionId -> connectionIds, the default connection first)
export function fixedConnectionReferences(connectionsBySession: Record<string, string[]> | Map<string, string[]>): ConnectionReferences {
    const sessions = connectionsBySession instanceof Map ? connectionsBySession : new Map(Object.entries(connectionsBySession));
    return {
        sessionsOf: connectionId => [...sessions].filter(([, connectionIds]) => connectionIds.includes(connectionId)).map(([sessionId]) => sessionId),
        connectionsOf: sessionId => sessions.get(sessionId) ?? [],
        subscribe: () => () => { },
    };
}
