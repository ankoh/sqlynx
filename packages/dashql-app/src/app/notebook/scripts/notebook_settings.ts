import type * as app_notebook from '@ankoh/dashql-jsonschema/app_notebook.js';

import type { ConnectorInfo } from '../connections/connector_info.js';

export type NotebookSettings = app_notebook.NotebookSettings;

/// The settings of a new notebook. Defaults depend on the connector of its main database.
export function createDefaultNotebookSettings(connectorInfo: ConnectorInfo): NotebookSettings {
    return {
        cacheQueryResults: connectorInfo.features.queryResultCaching,
    };
}

/// The settings of a persisted notebook.
/// Notebooks written before settings existed get the defaults of a new notebook.
export function readNotebookSettings(settings: Partial<NotebookSettings> | undefined, connectorInfo: ConnectorInfo): NotebookSettings {
    return { ...createDefaultNotebookSettings(connectorInfo), ...settings };
}
