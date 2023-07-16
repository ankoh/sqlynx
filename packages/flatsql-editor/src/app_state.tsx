import * as flatsql from '@ankoh/flatsql';

import { FlatSQLScriptState } from './editor/flatsql_analyzer';

/// The state of the application
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
    state.main.destroy(state.main);
    state.schema.destroy(state.schema);
    if (state.graphLayout) {
        state.graphLayout.delete();
        state.graphLayout = null;
    }
    return state;
}
