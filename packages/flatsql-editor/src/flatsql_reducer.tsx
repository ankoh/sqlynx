import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';
import { Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

import { useFlatSQL } from './flatsql_loader';
import { TMP_TPCH_SCHEMA } from './model/example_scripts';
import { FlatSQLState, FlatSQLScriptState, destroyState } from './flatsql_state';
import { Action, Dispatch } from './model/action';
import { buildDecorations } from './editor/decorations';
import { RESULT_OK } from './utils/result';

export const INITIALIZE = Symbol('INITIALIZE');
export const UPDATE_SCRIPT = Symbol('UPDATE_SCRIPT');
export const RESIZE_SCHEMA_GRAPH = Symbol('RESIZE_EDITOR');
export const DESTROY = Symbol('DESTORY');

export type FlatSQLAction =
    | Action<typeof INITIALIZE, flatsql.FlatSQL>
    | Action<typeof UPDATE_SCRIPT, flatsql.FlatSQLScript>
    | Action<typeof RESIZE_SCHEMA_GRAPH, [number, number]>
    | Action<typeof DESTROY, undefined>;

/// Reducer for FlatSQL actions
const reducer = (state: FlatSQLState, action: FlatSQLAction): FlatSQLState => {
    switch (action.type) {
        case INITIALIZE: {
            const s: FlatSQLState = {
                ...state,
                instance: action.value,
                main: {
                    ...state.main,
                    script: action.value.createScript(),
                },
                schema: {
                    ...state.schema,
                    script: action.value.createScript(),
                },
                graph: action.value.createSchemaGraph(),
            };
            s.main.script!.insertTextAt(0, TMP_TPCH_SCHEMA);
            return updateScript(s, s.main.script!);
        }
        case UPDATE_SCRIPT:
            return updateScript({ ...state }, action.value);
        case RESIZE_SCHEMA_GRAPH:
            return computeSchemaGraph({
                ...state,
                graphConfig: {
                    ...state.graphConfig,
                    boardWidth: action.value[0],
                    boardHeight: action.value[1],
                },
            });
        case DESTROY:
            return destroyState({ ...state });
    }
};

/// Compute a schema graph
function computeSchemaGraph(state: FlatSQLState): FlatSQLState {
    if (state.main.script == null) {
        return state;
    }
    console.time('Schema Graph Layout');
    if (state.graphLayout != null) {
        state.graphLayout.delete();
        state.graphLayout = null;
    }
    state.graph!.configure(state.graphConfig);
    state.graphLayout = state.graph!.loadScript(state.main.script);
    console.timeEnd('Schema Graph Layout');
    return state;
}

/// Analyze a script
function analyzeScript(state: FlatSQLScriptState): FlatSQLScriptState {
    if (!state.script) return state;
    // Scan the script
    console.time('Script Scanning');
    if (state.scanned != null) {
        state.scanned.delete();
        state.scanned = null;
    }
    state.scanned = state.script.scan();
    console.timeEnd('Script Scanning');

    // Parse the script
    console.time('Script Parsing');
    if (state.parsed != null) {
        state.parsed.delete();
        state.parsed = null;
    }
    state.parsed = state.script.parse();
    console.timeEnd('Script Parsing');

    // Parse the script
    console.time('Script Analyzing');
    if (state.analyzed != null) {
        state.analyzed.delete();
        state.analyzed = null;
    }
    state.analyzed = state.script.analyze();
    console.timeEnd('Script Analyzing');

    // Build decorations
    state.decorations = buildDecorations(state.scanned);
    return state;
}

/// Update a script
function updateScript(state: FlatSQLState, script: flatsql.FlatSQLScript): FlatSQLState {
    if (script === state.main.script) {
        state.main = analyzeScript({ ...state.main });
        computeSchemaGraph(state);
        return state;
    }
    if (script === state.schema.script) {
        state.schema = analyzeScript({ ...state.schema });
        computeSchemaGraph(state);
        return state;
    }
    return state;
}

const DEFAULT_BOARD_WIDTH = 800;
const DEFAULT_BOARD_HEIGHT = 600;

const defaultContext: FlatSQLState = {
    instance: null,
    main: {
        script: null,
        scanned: null,
        parsed: null,
        analyzed: null,
        decorations: new RangeSetBuilder<Decoration>().finish(),
    },
    schema: {
        script: null,
        scanned: null,
        parsed: null,
        analyzed: null,
        decorations: new RangeSetBuilder<Decoration>().finish(),
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

const context = React.createContext<FlatSQLState>(defaultContext);
const contextDispatch = React.createContext<Dispatch<FlatSQLAction>>(c => {});

type Props = {
    children: React.ReactElement;
};

export const FlatSQLStateProvider: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer(reducer, null, () => defaultContext);

    const backend = useFlatSQL();
    React.useEffect(() => {
        if (backend?.type == RESULT_OK && !state.instance) {
            dispatch({ type: INITIALIZE, value: backend.value });
        }
    }, [backend, state.instance]);
    return (
        <context.Provider value={state}>
            <contextDispatch.Provider value={dispatch}>{props.children}</contextDispatch.Provider>
        </context.Provider>
    );
};

export const useFlatSQLState = (): FlatSQLState => React.useContext(context)!;
export const useFlatSQLDispatch = (): Dispatch<FlatSQLAction> => React.useContext(contextDispatch);
