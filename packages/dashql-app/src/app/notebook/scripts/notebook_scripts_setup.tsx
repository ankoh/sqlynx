import * as React from 'react';
import { AttachedDatabaseState } from '../connections/attached_database_state.js';
import { NotebookScripts } from './notebook_scripts.js';
import { useNotebookScriptsAllocator } from './notebook_scripts_registry.js';
import { createEmptyMetadata } from './script_types.js';
import { createDefaultNotebookSettings } from './notebook_settings.js';

export type NotebookScriptsSetup = (notebookId: string, database: AttachedDatabaseState, name?: string) => NotebookScripts;

export function useNotebookScriptsSetup(): NotebookScriptsSetup {
    const allocateNotebookScripts = useNotebookScriptsAllocator();

    // New notebooks start without scripts; the feed greets them with the composer's landing prompt.
    return React.useCallback((notebookId: string, database: AttachedDatabaseState, name?: string) => {
        const [_notebookId, notebookScripts] = allocateNotebookScripts({
            notebookMetadata: createEmptyMetadata(),
            instance: database.instance,
            connectorInfo: database.connectorInfo,
            notebookId,
            name: name ?? null,
            settings: createDefaultNotebookSettings(database.connectorInfo),
            databaseId: database.databaseId,
            connectionCatalog: database.catalog,
            scripts: {},
            scriptRefs: {},
            scriptFocus: { fileName: '' },
            semanticUserFocus: null,
        }, database.catalogFunctionScript);
        return notebookScripts;
    }, [allocateNotebookScripts]);
}
