import * as flatsql from '@ankoh/flatsql';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { Transaction, StateField, RangeSetBuilder } from '@codemirror/state';

import { FlatSQLProcessor, FlatSQLScriptBuffers, FlatSQLScriptKey } from './flatsql_processor';

import './flatsql_decorations.css';

const TokenType = flatsql.proto.ScannerTokenType;
const KeywordDecoration = Decoration.mark({
    class: 'flatsql-keyword',
});
const FocusedQueryGraphEdgeDecoration = Decoration.mark({
    class: 'flatsql-queryedge-focus',
});
const FocusedTableReferenceDecoration = Decoration.mark({
    class: 'flatsql-tableref-focus',
});
const FocusedColumnReferenceDecoration = Decoration.mark({
    class: 'flatsql-colref-focus',
});

function buildDecorationsFromTokens(
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript>,
    tmp: flatsql.proto.ScannedScript = new flatsql.proto.ScannedScript(),
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const scan = scanned.read(tmp);
    const tokens = scan.tokens();
    if (tokens && tokens.tokenOffsetsArray()) {
        const tokenOffsets = tokens.tokenOffsetsArray()!;
        const tokenLengths = tokens.tokenLengthsArray()!;
        const tokenTypes = tokens.tokenTypesArray()!;
        for (let i = 0; i < tokenOffsets.length; ++i) {
            const offset = tokenOffsets[i];
            const length = tokenLengths[i];
            switch (tokenTypes[i]) {
                case TokenType.KEYWORD:
                    builder.add(offset, offset + length, KeywordDecoration);
                    break;
                default:
                    break;
            }
        }
    }
    return builder.finish();
}
interface ScannerDecorationState {
    decorations: DecorationSet;
    scriptBuffers: FlatSQLScriptBuffers;
}

/// Decorations derived from FlatSQL scanner tokens
const ScannerDecorationField: StateField<ScannerDecorationState> = StateField.define<ScannerDecorationState>({
    // Create the initial state
    create: () => {
        const config: ScannerDecorationState = {
            decorations: new RangeSetBuilder<Decoration>().finish(),
            scriptBuffers: {
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: () => {},
            },
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (state: ScannerDecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(FlatSQLProcessor);
        if (processor.scriptBuffers.scanned === state.scriptBuffers.scanned) {
            return state;
        }
        // Rebuild decorations
        const s = { ...state };
        s.scriptBuffers.scanned = processor.scriptBuffers.scanned;
        if (s.scriptBuffers.scanned) {
            s.decorations = buildDecorationsFromTokens(s.scriptBuffers.scanned);
        }
        return s;
    },
});

interface DecorationInfo {
    from: number;
    to: number;
    decoration: Decoration;
}

function buildDecorationsFromCursor(
    scriptKey: FlatSQLScriptKey | null,
    scriptBuffers: FlatSQLScriptBuffers,
    scriptCursor: flatsql.proto.ScriptCursorInfoT | null,
    focusedColumnRefs: Set<flatsql.QualifiedID.Value> | null,
    focusedTableRefs: Set<flatsql.QualifiedID.Value> | null,
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const parsed = scriptBuffers.parsed?.read(new flatsql.proto.ParsedScript()) ?? null;
    const analyzed = scriptBuffers.analyzed?.read(new flatsql.proto.AnalyzedScript()) ?? null;
    const queryEdgeId = scriptCursor?.queryEdgeId ?? null;
    const decorations: DecorationInfo[] = [];

    if (parsed === null || analyzed === null) {
        return builder.finish();
    }
    if (queryEdgeId !== null && queryEdgeId < analyzed.graphEdgesLength()) {
        const edge = analyzed.graphEdges(queryEdgeId)!;
        const edgeAstNodeId = edge.astNodeId();
        if (edgeAstNodeId < parsed.nodesLength()) {
            const edgeAstNode = parsed.nodes(edgeAstNodeId)!;
            const location = edgeAstNode?.location()!;
            decorations.push({
                from: location.offset(),
                to: location.offset() + location.length(),
                decoration: FocusedQueryGraphEdgeDecoration,
            });
        }
    }
    const tmpColRef = new flatsql.proto.ColumnReference();
    const tmpTblRef = new flatsql.proto.TableReference();
    const tmpNode = new flatsql.proto.Node();
    const tmpLoc = new flatsql.proto.Location();

    // Build decorations for column refs
    if (focusedColumnRefs !== null) {
        for (const refId of focusedColumnRefs) {
            const context = flatsql.QualifiedID.getContext(refId);
            const index = flatsql.QualifiedID.getIndex(refId);
            if (context !== scriptKey) {
                continue;
            }
            const columnRef = analyzed.columnReferences(index, tmpColRef)!;
            const astNodeId = columnRef.astNodeId()!;
            const astNode = parsed.nodes(astNodeId, tmpNode)!;
            const loc = astNode.location(tmpLoc)!;
            decorations.push({
                from: loc.offset(),
                to: loc.offset() + loc.length(),
                decoration: FocusedColumnReferenceDecoration,
            });
        }
    }

    // Build decorations for table refs
    if (focusedTableRefs !== null) {
        for (const refId of focusedTableRefs) {
            const context = flatsql.QualifiedID.getContext(refId);
            const index = flatsql.QualifiedID.getIndex(refId);
            if (context !== scriptKey) {
                continue;
            }
            const columnRef = analyzed.tableReferences(index, tmpTblRef)!;
            const astNodeId = columnRef.astNodeId()!;
            const astNode = parsed.nodes(astNodeId, tmpNode)!;
            const loc = astNode.location(tmpLoc)!;
            decorations.push({
                from: loc.offset(),
                to: loc.offset() + loc.length(),
                decoration: FocusedTableReferenceDecoration,
            });
        }
    }
    decorations.sort((l: DecorationInfo, r: DecorationInfo) => {
        return l.from - r.to;
    });
    for (const deco of decorations) {
        builder.add(deco.from, deco.to, deco.decoration);
    }
    return builder.finish();
}

interface FocusDecorationState {
    scriptKey: FlatSQLScriptKey | null;
    decorations: DecorationSet;
    scriptBuffers: FlatSQLScriptBuffers;
    scriptCursor: flatsql.proto.ScriptCursorInfoT | null;
    focusedColumnRefs: Set<flatsql.QualifiedID.Value> | null;
    focusedTableRefs: Set<flatsql.QualifiedID.Value> | null;
}

/// Decorations derived from FlatSQL cursor
const FocusDecorationField: StateField<FocusDecorationState> = StateField.define<FocusDecorationState>({
    // Create the initial state
    create: () => {
        const config: FocusDecorationState = {
            scriptKey: null,
            decorations: new RangeSetBuilder<Decoration>().finish(),
            scriptBuffers: {
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: () => {},
            },
            scriptCursor: null,
            focusedColumnRefs: null,
            focusedTableRefs: null,
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (state: FocusDecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(FlatSQLProcessor);
        if (
            processor.scriptKey === state.scriptKey &&
            processor.scriptBuffers.scanned === state.scriptBuffers.scanned &&
            processor.scriptBuffers.parsed === state.scriptBuffers.parsed &&
            processor.scriptBuffers.analyzed === state.scriptBuffers.analyzed &&
            processor.scriptCursor === state.scriptCursor &&
            processor.focusedColumnRefs === state.focusedColumnRefs &&
            processor.focusedTableRefs === state.focusedTableRefs
        ) {
            return state;
        }
        // Rebuild decorations
        const s = { ...state };
        s.scriptKey = processor.scriptKey;
        s.scriptBuffers.scanned = processor.scriptBuffers.scanned;
        s.scriptBuffers.parsed = processor.scriptBuffers.parsed;
        s.scriptBuffers.analyzed = processor.scriptBuffers.analyzed;
        s.scriptCursor = processor.scriptCursor;
        s.focusedColumnRefs = processor.focusedColumnRefs;
        s.focusedTableRefs = processor.focusedTableRefs;
        s.decorations = buildDecorationsFromCursor(
            s.scriptKey,
            s.scriptBuffers,
            s.scriptCursor,
            s.focusedColumnRefs,
            s.focusedTableRefs,
        );
        return s;
    },
});

const ScannerDecorations = EditorView.decorations.from(ScannerDecorationField, state => state.decorations);
const FocusDecorations = EditorView.decorations.from(FocusDecorationField, state => state.decorations);
/// Bundle the decoration extensions
export const FlatSQLDecorations = [ScannerDecorationField, ScannerDecorations, FocusDecorationField, FocusDecorations];
