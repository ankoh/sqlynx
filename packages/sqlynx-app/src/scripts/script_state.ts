import * as sqlynx from '@ankoh/sqlynx';
import Immutable from 'immutable';

import { CatalogUpdateTaskState, CatalogUpdateTaskVariant } from '../connectors/catalog_update';
import { generateBlankScript, ScriptMetadata } from './script_metadata';
import { ScriptLoadingStatus } from './script_loader';
import { SQLynxScriptBuffers } from '../view/editor/sqlynx_processor';
import { GraphViewModel } from '../view/schema/graph_view_model';
import { ScriptLoadingInfo } from './script_loader';
import { FocusInfo } from './focus';
import {
    QueryExecutionResult,
    QueryExecutionTaskState,
    QueryExecutionTaskVariant,
} from '../connectors/query_execution';

/// A key to identify the target script
export enum ScriptKey {
    MAIN_SCRIPT = 1,
    SCHEMA_SCRIPT = 2,
}
/// The state of the application
export interface ScriptState {
    /// The API
    instance: sqlynx.SQLynx | null;
    /// The catalog
    catalog: sqlynx.SQLynxCatalog | null;
    /// The catalog updates
    catalogUpdates: Immutable.Map<number, CatalogUpdateTaskState>;
    /// The pending catalog updates
    catalogUpdateRequests: Immutable.Map<number, CatalogUpdateTaskVariant>;
    /// The id for the next catalog update
    nextCatalogUpdateId: number;
    /// The scripts (main or external)j
    scripts: { [id: number]: ScriptData };
    /// The graph
    graph: sqlynx.SQLynxQueryGraphLayout | null;
    /// The graph config
    graphConfig: sqlynx.SQLynxQueryGraphLayoutConfig;
    /// The graph layout
    graphLayout: sqlynx.FlatBufferPtr<sqlynx.proto.QueryGraphLayout> | null;
    /// The graph view model
    graphViewModel: GraphViewModel;
    /// The user focus info
    userFocus: FocusInfo | null;
    /// The query execution was requested?
    queryExecutionRequest: QueryExecutionTaskVariant | null;
    /// The query execution state
    queryExecutionState: QueryExecutionTaskState | null;
    /// The response stream of the active query
    queryExecutionResult: QueryExecutionResult | null;
}

/// The script data
export interface ScriptData {
    /// The script key
    scriptKey: ScriptKey;
    /// The version, changes trigger reloads in the editor
    scriptVersion: number;
    /// The script
    script: sqlynx.SQLynxScript | null;
    /// The metadata
    metadata: ScriptMetadata;
    /// The loading info
    loading: ScriptLoadingInfo;
    /// The processed scripts
    processed: SQLynxScriptBuffers;
    /// The statistics
    statistics: Immutable.List<sqlynx.FlatBufferPtr<sqlynx.proto.ScriptStatistics>>;
    /// The cursor
    cursor: sqlynx.proto.ScriptCursorInfoT | null;
}

/// Destroy a state
export function destroyState(state: ScriptState): ScriptState {
    const main = state.scripts[ScriptKey.MAIN_SCRIPT];
    const schema = state.scripts[ScriptKey.SCHEMA_SCRIPT];
    main.processed.destroy(main.processed);
    schema.processed.destroy(schema.processed);
    if (state.catalog) {
        state.catalog.delete();
        state.catalog = null;
    }
    if (state.graphLayout) {
        state.graphLayout.delete();
        state.graphLayout = null;
    }
    for (const stats of main.statistics) {
        stats.delete();
    }
    for (const stats of schema.statistics) {
        stats.delete();
    }
    return state;
}

export function createDefaultScript(key: ScriptKey) {
    const script: ScriptData = {
        scriptKey: key,
        scriptVersion: 1,
        script: null,
        metadata: generateBlankScript(),
        loading: {
            status: ScriptLoadingStatus.SUCCEEDED,
            error: null,
            startedAt: null,
            finishedAt: null,
        },
        processed: {
            scanned: null,
            parsed: null,
            analyzed: null,
            destroy: () => {},
        },
        statistics: Immutable.List(),
        cursor: null,
    };
    return script;
}

export function createEmptyScript(key: ScriptKey, empty: sqlynx.SQLynxScript) {
    const script: ScriptData = {
        scriptKey: key,
        scriptVersion: 1,
        script: empty,
        metadata: generateBlankScript(),
        loading: {
            status: ScriptLoadingStatus.SUCCEEDED,
            error: null,
            startedAt: null,
            finishedAt: null,
        },
        processed: {
            scanned: null,
            parsed: null,
            analyzed: null,
            destroy: () => {},
        },
        statistics: Immutable.List(),
        cursor: null,
    };
    return script;
}
