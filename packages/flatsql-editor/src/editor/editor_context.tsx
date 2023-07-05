import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';
import { useBackend } from '../backend';
import { DecorationSet, Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { RangeSet } from '@codemirror/state';
import { Action, Dispatch } from '../model/action';
import { RESULT_OK } from '../utils/result';

/// The state of the FlatSQL editor plugin.
/// We pass this state container to the event callback so that it can be propagated as React state.
export interface EditorContext {
    /// The API
    instance: flatsql.FlatSQL | null;
    /// The main script
    mainScript: flatsql.FlatSQLScript | null;
    /// The schema script
    schemaScript: flatsql.FlatSQLScript | null;
    /// The scanned script
    mainScanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    /// The parsed script
    mainParsed: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    /// The analyzed script
    mainAnalyzed: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;
    /// The decorations
    decorations: DecorationSet;
}

function destroy(ctx: EditorContext): EditorContext {
    if (ctx.mainScanned != null) {
        ctx.mainScanned.delete();
        ctx.mainScanned = null;
    }
    if (ctx.mainParsed != null) {
        ctx.mainParsed.delete();
        ctx.mainParsed = null;
    }
    if (ctx.mainAnalyzed != null) {
        ctx.mainAnalyzed.delete();
        ctx.mainAnalyzed = null;
    }
    if (ctx.mainScript != null) {
        ctx.mainScript!.delete();
        ctx.mainScript = null;
    }
    if (ctx.schemaScript) {
        ctx.schemaScript.delete();
        ctx.schemaScript = null;
    }
    return ctx;
}

function updateScript(ctx: EditorContext): EditorContext {
    if (!ctx.mainScript) return ctx;
    // Scan the script
    console.time('Script Scanning');
    if (ctx.mainScanned != null) {
        ctx.mainScanned.delete();
        ctx.mainScanned = null;
    }
    ctx.mainScanned = ctx.mainScript.scan();
    console.timeEnd('Script Scanning');

    // Parse the script
    console.time('Script Parsing');
    if (ctx.mainParsed != null) {
        ctx.mainParsed.delete();
        ctx.mainParsed = null;
    }
    ctx.mainParsed = ctx.mainScript.parse();
    console.timeEnd('Script Parsing');

    // Parse the script
    console.time('Script Analyzing');
    if (ctx.mainAnalyzed != null) {
        ctx.mainAnalyzed.delete();
        ctx.mainAnalyzed = null;
    }
    ctx.mainAnalyzed = ctx.mainScript.analyze();
    console.timeEnd('Script Analyzing');

    // Build decorations
    ctx.decorations = buildDecorations(ctx.mainScanned);
    return ctx;
}

const Token = flatsql.proto.HighlightingTokenType;
const keywordDecoration = Decoration.mark({
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
        let prevType = Token.NONE;
        for (let i = 0; i < tokenOffsets.length; ++i) {
            const begin = prevOffset;
            const end = tokenOffsets[i];
            switch (prevType) {
                case Token.KEYWORD:
                    builder.add(begin, end, keywordDecoration);
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
export const MAIN_SCRIPT_UPDATED = Symbol('UPDATE_MAIN_SCRIPT');
export const DESTORY_SCRIPTS = Symbol('DESTORY');
export type EditorContextAction =
    | Action<typeof INITIALIZE, flatsql.FlatSQL>
    | Action<typeof MAIN_SCRIPT_UPDATED, undefined>
    | Action<typeof DESTORY_SCRIPTS, undefined>;

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

const reducer = (state: EditorContext, action: EditorContextAction): EditorContext => {
    switch (action.type) {
        case INITIALIZE: {
            const s = {
                ...state,
                instance: action.value,
                mainScript: action.value.createScript(),
                schemaScript: action.value.createScript(),
            };
            s.mainScript.insertTextAt(0, TMP_TPCH_SCHEMA);
            updateScript(s);
            return s;
        }
        case MAIN_SCRIPT_UPDATED:
            console.log('MAIN_SCRIPT_UPDATED');
            return updateScript({ ...state });
        case DESTORY_SCRIPTS:
            return destroy({ ...state });
    }
};

type Props = {
    children: React.ReactElement;
};

const defaultContext: EditorContext = {
    instance: null,
    mainScript: null,
    schemaScript: null,
    mainScanned: null,
    mainParsed: null,
    mainAnalyzed: null,
    decorations: new RangeSetBuilder<Decoration>().finish(),
};

const editorCtx = React.createContext<EditorContext>(defaultContext);
const editorCtxDispatch = React.createContext<Dispatch<EditorContextAction>>(c => {});

export const EditorContextProvider: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer(reducer, null, () => defaultContext);

    const backend = useBackend();
    React.useEffect(() => {
        if (backend?.type == RESULT_OK && !state.instance) {
            dispatch({ type: INITIALIZE, value: backend.value });
        }
    }, [backend, state.instance]);
    return (
        <editorCtx.Provider value={state}>
            <editorCtxDispatch.Provider value={dispatch}>{props.children}</editorCtxDispatch.Provider>
        </editorCtx.Provider>
    );
};

export const useEditorContext = (): EditorContext => React.useContext(editorCtx)!;
export const useEditorContextDispatch = (): Dispatch<EditorContextAction> => React.useContext(editorCtxDispatch);
