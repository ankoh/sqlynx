import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';
import { useFlatSQL } from './flatsql_loader';
import { DecorationSet, Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { RangeSet } from '@codemirror/state';
import { Action, Dispatch } from './model/action';
import { RESULT_OK } from './utils/result';

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
function destroy(state: FlatSQLState): FlatSQLState {
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

const TokenType = flatsql.proto.HighlightingTokenType;
const KeywordDecoration = Decoration.mark({
    class: 'flatsql-keyword',
});
/// Update the CodeMirror decorations
function buildDecorations(scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript>): RangeSet<Decoration> {
    // Build decorations
    let builder = new RangeSetBuilder<Decoration>();
    const scan = scanned.read(new flatsql.proto.ScannedScript());
    const hl = scan.highlighting();
    if (hl && hl.tokenOffsetsArray()) {
        const tokenOffsets = hl.tokenOffsetsArray()!;
        const tokenTypes = hl.tokenTypesArray()!;
        let prevOffset = 0;
        let prevType = TokenType.NONE;
        for (let i = 0; i < tokenOffsets.length; ++i) {
            const begin = prevOffset;
            const end = tokenOffsets[i];
            switch (prevType) {
                case TokenType.KEYWORD:
                    builder.add(begin, end, KeywordDecoration);
                    break;
                default:
                    break;
            }
            prevOffset = end;
            prevType = tokenTypes[i];
        }
    }
    return builder.finish();
}

export const INITIALIZE = Symbol('INITIALIZE');
export const UPDATE_SCRIPT = Symbol('UPDATE_SCRIPT');
export const RESIZE_SCHEMA_GRAPH = Symbol('RESIZE_EDITOR');
export const DESTROY = Symbol('DESTORY');
export type EditorContextAction =
    | Action<typeof INITIALIZE, flatsql.FlatSQL>
    | Action<typeof UPDATE_SCRIPT, flatsql.FlatSQLScript>
    | Action<typeof RESIZE_SCHEMA_GRAPH, [number, number]>
    | Action<typeof DESTROY, undefined>;

const TMP_TPCH_SCHEMA = `create table part (
   p_partkey integer not null,
   p_name varchar(55) not null,
   p_mfgr char(25) not null,
   p_brand char(10) not null,
   p_type varchar(25) not null,
   p_size integer not null,
   p_container char(10) not null,
   p_retailprice decimal(12,2) not null,
   p_comment varchar(23) not null,
   primary key (p_partkey)
);

create table supplier (
   s_suppkey integer not null,
   s_name char(25) not null,
   s_address varchar(40) not null,
   s_nationkey integer not null,
   s_phone char(15) not null,
   s_acctbal decimal(12,2) not null,
   s_comment varchar(101) not null,
   primary key (s_suppkey)
);

create table partsupp (
   ps_partkey integer not null,
   ps_suppkey integer not null,
   ps_availqty integer not null,
   ps_supplycost decimal(12,2) not null,
   ps_comment varchar(199) not null,
   primary key (ps_partkey,ps_suppkey)
);

create table customer (
   c_custkey integer not null,
   c_name varchar(25) not null,
   c_address varchar(40) not null,
   c_nationkey integer not null,
   c_phone char(15) not null,
   c_acctbal decimal(12,2) not null,
   c_mktsegment char(10) not null,
   c_comment varchar(117) not null,
   primary key (c_custkey)
);

create table orders (
   o_orderkey integer not null,
   o_custkey integer not null,
   o_orderstatus char(1) not null,
   o_totalprice decimal(12,2) not null,
   o_orderdate date not null,
   o_orderpriority char(15) not null,
   o_clerk char(15) not null,
   o_shippriority integer not null,
   o_comment varchar(79) not null,
   primary key (o_orderkey)
);

create table lineitem (
   l_orderkey integer not null,
   l_partkey integer not null,
   l_suppkey integer not null,
   l_linenumber integer not null,
   l_quantity decimal(12,2) not null,
   l_extendedprice decimal(12,2) not null,
   l_discount decimal(12,2) not null,
   l_tax decimal(12,2) not null,
   l_returnflag char(1) not null,
   l_linestatus char(1) not null,
   l_shipdate date not null,
   l_commitdate date not null,
   l_receiptdate date not null,
   l_shipinstruct char(25) not null,
   l_shipmode char(10) not null,
   l_comment varchar(44) not null,
   primary key (l_orderkey,l_linenumber)
);

create table nation (
   n_nationkey integer not null,
   n_name char(25) not null,
   n_regionkey integer not null,
   n_comment varchar(152) not null,
   primary key (n_nationkey)
);

create table region (
   r_regionkey integer not null,
   r_name char(25) not null,
   r_comment varchar(152) not null,
   primary key (r_regionkey)
);
`;

const reducer = (state: FlatSQLState, action: EditorContextAction): FlatSQLState => {
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
            return destroy({ ...state });
    }
};

type Props = {
    children: React.ReactElement;
};

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
const contextDispatch = React.createContext<Dispatch<EditorContextAction>>(c => {});

export const FlatSQLContextProvider: React.FC<Props> = (props: Props) => {
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
export const useFlatSQLDispatch = (): Dispatch<EditorContextAction> => React.useContext(contextDispatch);
