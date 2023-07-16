import * as flatsql from '@ankoh/flatsql';

import { FlatSQLScriptState, destroyScriptState } from './editor/flatsql_analyzer';

/// A script key
export enum ScriptKey {
    MAIN_SCRIPT = 1,
    SCHEMA_SCRIPT = 2,
}

/// The state of the application.
/// We pass this state container to the event callback so that it can be propagated as React state.
export interface AppState {
    /// The API
    instance: flatsql.FlatSQL | null;
    /// The main script
    main: FlatSQLScriptState;
    /// The main script
    schema: FlatSQLScriptState;
    /// The graph
    graph: flatsql.FlatSQLSchemaGraph | null;
    /// The graph layout
    graphLayout: flatsql.FlatBufferRef<flatsql.proto.SchemaGraphLayout> | null;
    /// The graph config
    graphConfig: flatsql.FlatSQLSchemaGraphConfig;
}

/// Destroy a state
export function destroyState(state: AppState): AppState {
    destroyScriptState(state.main);
    destroyScriptState(state.schema);
    if (state.graphLayout) {
        state.graphLayout.delete();
        state.graphLayout = null;
    }
    return state;
}
