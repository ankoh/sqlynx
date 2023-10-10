import * as flatsql from '@ankoh/flatsql';
import Immutable from 'immutable';

import { generateBlankScript } from '../script_loader/script_metadata';
import { LoadingStatus } from '../script_loader/script_loader';

import { FlatSQLScriptBuffers } from '../editor/flatsql_processor';
import { ScriptMetadata } from '../script_loader/script_metadata';
import { LoadingInfo } from '../script_loader/script_loader';
import { GraphViewModel } from '../schema_graph/graph_view_model';
import { FocusInfo } from './focus';

const DEFAULT_BOARD_WIDTH = 800;
const DEFAULT_BOARD_HEIGHT = 600;

/// A key to identify the target script
export enum ScriptKey {
    MAIN_SCRIPT = 1,
    SCHEMA_SCRIPT = 2,
}
/// The state of the application
export interface AppState {
    /// The API
    instance: flatsql.FlatSQL | null;
    /// The main script
    scripts: { [context: number]: ScriptData };
    /// The graph
    graph: flatsql.FlatSQLSchemaGraph | null;
    /// The graph config
    graphConfig: flatsql.FlatSQLSchemaGraphConfig;
    /// The graph layout
    graphLayout: flatsql.FlatBufferRef<flatsql.proto.SchemaGraphLayout> | null;
    /// The graph view model
    graphViewModel: GraphViewModel;
    /// The user focus
    focus: FocusInfo | null;
}

/// The script data
export interface ScriptData {
    /// The script key
    scriptKey: ScriptKey;
    /// The script
    script: flatsql.FlatSQLScript | null;
    /// The metadata
    metadata: ScriptMetadata;
    /// The loading info
    loading: LoadingInfo;
    /// The processed scripts
    processed: FlatSQLScriptBuffers;
    /// The statistics
    statistics: Immutable.List<flatsql.FlatBufferRef<flatsql.proto.ScriptStatistics>>;
    /// The cursor
    cursor: flatsql.proto.ScriptCursorInfoT | null;
}

/// Destroy a state
export function destroyState(state: AppState): AppState {
    const main = state.scripts[ScriptKey.MAIN_SCRIPT];
    const schema = state.scripts[ScriptKey.SCHEMA_SCRIPT];
    main.processed.destroy(main.processed);
    schema.processed.destroy(schema.processed);
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
        script: null,
        metadata: generateBlankScript(),
        loading: {
            status: LoadingStatus.SUCCEEDED,
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

export function createEmptyScript(key: ScriptKey, api: flatsql.FlatSQL) {
    const script: ScriptData = {
        scriptKey: key,
        script: api.createScript(key),
        metadata: generateBlankScript(),
        loading: {
            status: LoadingStatus.SUCCEEDED,
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

export function createDefaultState(): AppState {
    return {
        instance: null,
        scripts: {
            [ScriptKey.MAIN_SCRIPT]: createDefaultScript(ScriptKey.MAIN_SCRIPT),
            [ScriptKey.SCHEMA_SCRIPT]: createDefaultScript(ScriptKey.SCHEMA_SCRIPT),
        },
        graph: null,
        graphConfig: {
            boardWidth: DEFAULT_BOARD_WIDTH,
            boardHeight: DEFAULT_BOARD_HEIGHT,
            cellWidth: 120,
            cellHeight: 64,
            tableWidth: 180,
            tableHeight: 36,
        },
        graphLayout: null,
        graphViewModel: {
            nodes: [],
            nodesByTable: new Map(),
            edges: new Map(),
        },
        focus: null,
    };
}
