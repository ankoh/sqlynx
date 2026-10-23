import * as React from 'react';
import { ConnectionState } from '../connections/connection_state.js';
import { sessionConnectionFromState } from '../connections/connection_registry.js';
import { useStorageWriter } from '../storage/storage_provider.js';
import { groupSessionManifestWrites, WRITE_SESSION_MANIFEST } from '../storage/storage_writer.js';
import { SessionScripts } from './scripts/session_scripts.js';
import { useSessionScriptsAllocator } from './scripts/session_scripts_registry.js';
import { createEmptyMetadata } from './scripts/script_types.js';
import { createDefaultSessionSettings } from './scripts/session_settings.js';

/// Create a session whose scripts use a connection by default
export type SessionCreation = (database: ConnectionState, name?: string) => SessionScripts;

export function useSessionCreation(): SessionCreation {
    const allocateSessionScripts = useSessionScriptsAllocator();
    const storageWriter = useStorageWriter();

    // New sessions start without scripts; the feed greets them with the composer's landing prompt.
    return React.useCallback((database: ConnectionState, name?: string) => {
        const sessionId = crypto.randomUUID();
        const [_sessionId, sessionScripts] = allocateSessionScripts({
            sessionMetadata: createEmptyMetadata(),
            instance: database.instance,
            connectorInfo: database.connectorInfo,
            sessionId,
            name: name ?? null,
            settings: createDefaultSessionSettings(database.connectorInfo),
            connectionId: database.connectionId,
            connectionCatalog: database.catalog,
            scripts: {},
            scriptRefs: {},
            scriptOrder: [],
            scriptFocus: { fileName: '' },
            semanticUserFocus: null,
        });
        void storageWriter.write(
            groupSessionManifestWrites(sessionId),
            { type: WRITE_SESSION_MANIFEST, value: [sessionId, database.connectionId, [sessionConnectionFromState(database)]] },
        );
        return sessionScripts;
    }, [allocateSessionScripts, storageWriter]);
}
