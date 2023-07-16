import * as flatsql from '@ankoh/flatsql';

import { generateBlankScript } from './script_loader/script_metadata';
import { LoadingStatus } from './script_loader/script_loader';

import { FlatSQLAnalysisData } from './editor/flatsql_analyzer';
import { ScriptMetadata } from './script_loader/script_metadata';
import { LoadingInfo } from './script_loader/script_loader';

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
    scripts: { [key: number]: ScriptData };
    /// The graph
    graph: flatsql.FlatSQLSchemaGraph | null;
    /// The graph layout
    graphLayout: flatsql.FlatBufferRef<flatsql.proto.SchemaGraphLayout> | null;
    /// The graph config
    graphConfig: flatsql.FlatSQLSchemaGraphConfig;
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
    /// The analysis info
    analysis: FlatSQLAnalysisData;
}

/// Destroy a state
export function destroyState(state: AppState): AppState {
    const main = state.scripts[ScriptKey.MAIN_SCRIPT];
    const schema = state.scripts[ScriptKey.SCHEMA_SCRIPT];
    main.analysis.destroy(main.analysis);
    schema.analysis.destroy(schema.analysis);
    if (state.graphLayout) {
        state.graphLayout.delete();
        state.graphLayout = null;
    }
    return state;
}

export function createDefaultScript(key: ScriptKey) {
    return {
        scriptKey: key,
        script: null,
        metadata: generateBlankScript(),
        loading: {
            status: LoadingStatus.SUCCEEDED,
            error: null,
            startedAt: null,
            finishedAt: null,
        },
        analysis: {
            scanned: null,
            parsed: null,
            analyzed: null,
            destroy: () => {},
        },
    };
}

export function createEmptyScript(key: ScriptKey, api: flatsql.FlatSQL) {
    return {
        scriptKey: key,
        script: api.createScript(),
        metadata: generateBlankScript(),
        loading: {
            status: LoadingStatus.SUCCEEDED,
            error: null,
            startedAt: null,
            finishedAt: null,
        },
        analysis: {
            scanned: null,
            parsed: null,
            analyzed: null,
            destroy: () => {},
        },
    };
}

const DEFAULT_BOARD_WIDTH = 800;
const DEFAULT_BOARD_HEIGHT = 600;

export function createDefaultState(): AppState {
    return {
        instance: null,
        scripts: {
            [ScriptKey.MAIN_SCRIPT]: createDefaultScript(ScriptKey.MAIN_SCRIPT),
            [ScriptKey.SCHEMA_SCRIPT]: createDefaultScript(ScriptKey.SCHEMA_SCRIPT),
        },
        graph: null,
        graphLayout: null,
        graphConfig: {
            iterationCount: 50.0,
            forceScaling: 100.0,
            cooldownFactor: 0.96,
            repulsionForce: 0.5,
            edgeAttractionForce: 0.5,
            gravityForce: 1.6,
            initialRadius: 100.0,
            boardWidth: DEFAULT_BOARD_WIDTH,
            boardHeight: DEFAULT_BOARD_HEIGHT,
            tableWidth: 180,
            tableConstantHeight: 24,
            tableColumnHeight: 8,
            tableMaxHeight: 36,
            tableMargin: 20,
        },
    };
}
