import * as sqlynx from '@ankoh/sqlynx';
import Immutable from 'immutable';

import { generateBlankScript, ScriptMetadata } from '../scripts/script_metadata';
import { LoadingStatus } from '../scripts/script_loader';

import { SQLynxScriptBuffers } from '../view/editor/sqlynx_processor';
import { GraphViewModel } from '../view/schema/graph_view_model';
import { LoadingInfo } from '../scripts/script_loader';
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
    instance: sqlynx.SQLynx | null;
    /// The main script
    scripts: { [context: number]: ScriptData };
    /// The schema search path
    schemaSearchPath: sqlynx.SQLynxSchemaSearchPath | null;
    /// The graph
    graph: sqlynx.SQLynxSchemaLayout | null;
    /// The graph config
    graphConfig: sqlynx.SQLynxSchemaLayoutConfig;
    /// The graph layout
    graphLayout: sqlynx.FlatBufferRef<sqlynx.proto.SchemaLayout> | null;
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
    script: sqlynx.SQLynxScript | null;
    /// The metadata
    metadata: ScriptMetadata;
    /// The loading info
    loading: LoadingInfo;
    /// The processed scripts
    processed: SQLynxScriptBuffers;
    /// The statistics
    statistics: Immutable.List<sqlynx.FlatBufferRef<sqlynx.proto.ScriptStatistics>>;
    /// The cursor
    cursor: sqlynx.proto.ScriptCursorInfoT | null;
}

/// Destroy a state
export function destroyState(state: AppState): AppState {
    const main = state.scripts[ScriptKey.MAIN_SCRIPT];
    const schema = state.scripts[ScriptKey.SCHEMA_SCRIPT];
    main.processed.destroy(main.processed);
    schema.processed.destroy(schema.processed);
    if (state.schemaSearchPath) {
        state.schemaSearchPath.delete();
        state.schemaSearchPath = null;
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

export function createEmptyScript(key: ScriptKey, api: sqlynx.SQLynx) {
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
        schemaSearchPath: null,
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
            boundaries: {
                minX: 0,
                maxX: 0,
                minY: 0,
                maxY: 0,
                totalWidth: 0,
                totalHeight: 0,
            },
        },
        focus: null,
    };
}
