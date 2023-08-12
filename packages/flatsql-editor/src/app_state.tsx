import * as flatsql from '@ankoh/flatsql';
import Immutable from 'immutable';

import { generateBlankScript } from './script_loader/script_metadata';
import { LoadingStatus } from './script_loader/script_loader';

import { FlatSQLScriptBuffers } from './editor/flatsql_processor';
import { ScriptMetadata } from './script_loader/script_metadata';
import { LoadingInfo } from './script_loader/script_loader';
import { SchemaGraphViewModel } from './schema_graph/graph_view_model';

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
    scripts: { [key: number]: ScriptData };
    /// The graph
    graph: flatsql.FlatSQLSchemaGraph | null;
    /// The graph config
    graphConfig: flatsql.FlatSQLSchemaGraphConfig;
    /// The graph layout
    graphLayout: flatsql.FlatBufferRef<flatsql.proto.SchemaGraphLayout> | null;
    /// The graph debug mode
    graphDebugMode: boolean;
    /// The graph debug mode
    graphDebugInfo: flatsql.FlatBufferRef<flatsql.proto.SchemaGraphDebugInfo> | null;
    /// The graph view model
    graphViewModel: SchemaGraphViewModel;
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

export interface GraphNodeDescriptor {
    /// The node
    nodeId: number;
    /// The port
    port: number | null;
}

export type ConnectionId = bigint;

export enum FocusTarget {
    Graph,
    Script,
}

export interface FocusInfo {
    /// The focused script key (if any)
    target: FocusTarget;
    /// The layout indices in the schema graph as (nodeId -> port bits) map
    graphNodes: Map<number, number>;
    /// The connection ids of focused edges
    graphConnections: Set<ConnectionId>;
    /// The focused table columns as (tableId -> columnId[]) map.
    /// Only set if specific table columns are referenced.
    tableColumns: Map<number, number[]>;
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
        script: api.createScript(),
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
            iterationsClustering: 10,
            iterationsRefinement: 40,
            forceScaling: 10.0,
            cooldownFactor: 0.99,
            repulsionForce: 3.0,
            edgeAttractionForce: 2.0,
            gravityForce: 1.0,
            initialRadius: 400.0,
            boardWidth: DEFAULT_BOARD_WIDTH,
            boardHeight: DEFAULT_BOARD_HEIGHT,
            tableWidth: 180,
            tableHeight: 36,
            tableMargin: 32,
            gridSize: 16,
        },
        graphLayout: null,
        graphDebugMode: false,
        graphDebugInfo: null,
        graphViewModel: {
            nodes: [],
            edges: new Map(),
            debugInfo: null,
        },
        focus: null,
    };
}

export function buildConnectionId(from: number, to: number): ConnectionId {
    return (BigInt(from) << 32n) | BigInt(to);
}

export function unpackConnectionId(id: ConnectionId): [number, number] {
    const from = id >> 32n;
    const to = id & ((1n << 32n) - 1n);
    return [Number(from), Number(to)];
}
