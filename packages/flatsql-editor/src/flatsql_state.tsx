import * as flatsql from '@ankoh/flatsql';
import { DecorationSet } from '@codemirror/view';

/// The state of a FlatSQL script.
export interface FlatSQLScriptState {
    /// The script
    script: flatsql.FlatSQLScript | null;
    /// The scanned script
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    /// The parsed script
    parsed: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    /// The analyzed script
    analyzed: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;
    /// The decorations
    decorations: DecorationSet;
}

/// The state of the FlatSQL module.
/// We pass this state container to the event callback so that it can be propagated as React state.
export interface FlatSQLState {
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
export function destroyState(state: FlatSQLState): FlatSQLState {
    const destroyScriptState = (state: FlatSQLScriptState) => {
        if (state.scanned != null) {
            state.scanned.delete();
            state.scanned = null;
        }
        if (state.parsed != null) {
            state.parsed.delete();
            state.parsed = null;
        }
        if (state.analyzed != null) {
            state.analyzed.delete();
            state.analyzed = null;
        }
        if (state.script != null) {
            state.script!.delete();
            state.script = null;
        }
        return state;
    };
    destroyScriptState(state.main);
    destroyScriptState(state.schema);
    if (state.graphLayout) {
        state.graphLayout.delete();
        state.graphLayout = null;
    }
    return state;
}
