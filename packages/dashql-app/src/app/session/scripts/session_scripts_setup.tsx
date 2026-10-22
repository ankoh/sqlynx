import * as React from 'react';
import { ConnectionState } from '../../connections/connection_state.js';
import { SessionScripts } from './session_scripts.js';
import { useSessionScriptsAllocator } from './session_scripts_registry.js';
import { createEmptyMetadata } from './script_types.js';
import { createDefaultSessionSettings } from './session_settings.js';

export type SessionScriptsSetup = (sessionId: string, database: ConnectionState, name?: string) => SessionScripts;

export function useSessionScriptsSetup(): SessionScriptsSetup {
    const allocateSessionScripts = useSessionScriptsAllocator();

    // New sessions start without scripts; the feed greets them with the composer's landing prompt.
    return React.useCallback((sessionId: string, database: ConnectionState, name?: string) => {
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
            scriptFocus: { fileName: '' },
            semanticUserFocus: null,
        }, database.catalogFunctionScript);
        return sessionScripts;
    }, [allocateSessionScripts]);
}
