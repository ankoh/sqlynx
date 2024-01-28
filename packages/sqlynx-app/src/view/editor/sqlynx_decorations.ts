import * as sqlynx from '@ankoh/sqlynx-core';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { EditorState, Transaction, StateField, RangeSetBuilder } from '@codemirror/state';
import { highlightingFor } from '@codemirror/language';
import { tags as CODEMIRROR_TAGS, Tag } from '@lezer/highlight';

import { SQLynxProcessor, SQLynxScriptBuffers, SQLynxScriptKey } from './sqlynx_processor';

import './sqlynx_decorations.css';

const PROTO_TAG_MAPPING: Map<sqlynx.proto.ScannerTokenType, Tag> = new Map([
    [sqlynx.proto.ScannerTokenType.KEYWORD, CODEMIRROR_TAGS.keyword],
    [sqlynx.proto.ScannerTokenType.OPERATOR, CODEMIRROR_TAGS.operator],
    [sqlynx.proto.ScannerTokenType.LITERAL_BINARY, CODEMIRROR_TAGS.literal],
    [sqlynx.proto.ScannerTokenType.LITERAL_BOOLEAN, CODEMIRROR_TAGS.bool],
    [sqlynx.proto.ScannerTokenType.LITERAL_FLOAT, CODEMIRROR_TAGS.float],
    [sqlynx.proto.ScannerTokenType.LITERAL_HEX, CODEMIRROR_TAGS.number],
    [sqlynx.proto.ScannerTokenType.LITERAL_STRING, CODEMIRROR_TAGS.string],
    [sqlynx.proto.ScannerTokenType.LITERAL_INTEGER, CODEMIRROR_TAGS.integer],
    [sqlynx.proto.ScannerTokenType.IDENTIFIER, CODEMIRROR_TAGS.name],
    [sqlynx.proto.ScannerTokenType.COMMENT, CODEMIRROR_TAGS.comment],
]);
const CODEMIRROR_TAGS_USED: Set<Tag> = new Set();
for (const [_token, tag] of PROTO_TAG_MAPPING) {
    CODEMIRROR_TAGS_USED.add(tag);
}

const FocusedQueryGraphEdgeDecoration = Decoration.mark({
    class: 'sqlynx-queryedge-focus',
});
const FocusedTableReferenceDecoration = Decoration.mark({
    class: 'sqlynx-tableref-focus',
});
const FocusedColumnReferenceDecoration = Decoration.mark({
    class: 'sqlynx-colref-focus',
});
const ErrorDecoration = Decoration.mark({
    class: 'sqlynx-error',
});

function buildDecorationsFromTokens(
    state: EditorState,
    scanned: sqlynx.FlatBufferPtr<sqlynx.proto.ScannedScript>,
    tmp: sqlynx.proto.ScannedScript = new sqlynx.proto.ScannedScript(),
): DecorationSet {
    const decorations: Map<Tag, Decoration> = new Map();
    for (const tag of CODEMIRROR_TAGS_USED) {
        decorations.set(
            tag,
            Decoration.mark({
                class: highlightingFor(state, [tag]) ?? '',
            }),
        );
    }

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
            const tag = PROTO_TAG_MAPPING.get(tokenTypes[i]);
            if (tag) {
                const decoration = decorations.get(tag)!;
                builder.add(offset, offset + length, decoration);
            }
        }
    }
    return builder.finish();
}
interface ScannerDecorationState {
    decorations: DecorationSet;
    scriptBuffers: SQLynxScriptBuffers;
}

/// Decorations derived from SQLynx scanner tokens
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
    // Mirror the SQLynx state
    update: (state: ScannerDecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(SQLynxProcessor);
        if (processor.scriptBuffers.scanned === state.scriptBuffers.scanned) {
            return state;
        }
        // Rebuild decorations
        const s = { ...state };
        s.scriptBuffers.scanned = processor.scriptBuffers.scanned;
        if (s.scriptBuffers.scanned) {
            s.decorations = buildDecorationsFromTokens(transaction.state, s.scriptBuffers.scanned);
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
    scriptKey: SQLynxScriptKey | null,
    scriptBuffers: SQLynxScriptBuffers,
    scriptCursor: sqlynx.proto.ScriptCursorInfoT | null,
    focusedColumnRefs: Set<sqlynx.ExternalObjectID.Value> | null,
    focusedTableRefs: Set<sqlynx.ExternalObjectID.Value> | null,
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const scanned = scriptBuffers.scanned?.read(new sqlynx.proto.ScannedScript()) ?? null;
    const parsed = scriptBuffers.parsed?.read(new sqlynx.proto.ParsedScript()) ?? null;
    const analyzed = scriptBuffers.analyzed?.read(new sqlynx.proto.AnalyzedScript()) ?? null;
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
    const tmpColRef = new sqlynx.proto.ColumnReference();
    const tmpTblRef = new sqlynx.proto.TableReference();
    const tmpNode = new sqlynx.proto.Node();
    const tmpLoc = new sqlynx.proto.Location();
    const tmpError = new sqlynx.proto.Error();

    // Build decorations for column refs
    if (focusedColumnRefs !== null) {
        for (const refId of focusedColumnRefs) {
            const externalId = sqlynx.ExternalObjectID.getExternalID(refId);
            const objectId = sqlynx.ExternalObjectID.getObjectID(refId);
            if (externalId !== scriptKey) {
                continue;
            }
            // XXX invalidate focused table refs at write front
            if (objectId >= analyzed.columnReferencesLength()) {
                continue;
            }
            const columnRef = analyzed.columnReferences(objectId, tmpColRef)!;
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
            const externalId = sqlynx.ExternalObjectID.getExternalID(refId);
            const objectId = sqlynx.ExternalObjectID.getObjectID(refId);
            if (externalId !== scriptKey) {
                continue;
            }
            // XXX invalidate focused table refs at write front
            if (objectId >= analyzed.tableReferencesLength()) {
                continue;
            }
            const columnRef = analyzed.tableReferences(objectId, tmpTblRef)!;
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

    // Are there any scanner errors?
    if (scanned != null) {
        for (let i = 0; i < scanned.errorsLength(); ++i) {
            const error = scanned.errors(i, tmpError)!;
            const loc = error.location(tmpLoc)!;
            decorations.push({
                from: loc.offset(),
                to: loc.offset() + loc.length(),
                decoration: ErrorDecoration,
            });
        }
    }
    // Are there any parser errors?
    if (parsed !== null) {
        for (let i = 0; i < parsed.errorsLength(); ++i) {
            const error = parsed.errors(i, tmpError)!;
            const loc = error.location(tmpLoc)!;
            decorations.push({
                from: loc.offset(),
                to: loc.offset() + loc.length(),
                decoration: ErrorDecoration,
            });
        }
    }

    decorations.sort((l: DecorationInfo, r: DecorationInfo) => {
        return l.from - r.from;
    });
    for (const deco of decorations) {
        builder.add(deco.from, deco.to, deco.decoration);
    }
    return builder.finish();
}

interface FocusDecorationState {
    scriptKey: SQLynxScriptKey | null;
    decorations: DecorationSet;
    scriptBuffers: SQLynxScriptBuffers;
    scriptCursor: sqlynx.proto.ScriptCursorInfoT | null;
    focusedColumnRefs: Set<sqlynx.ExternalObjectID.Value> | null;
    focusedTableRefs: Set<sqlynx.ExternalObjectID.Value> | null;
}

/// Decorations derived from SQLynx cursor
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
    // Mirror the SQLynx state
    update: (state: FocusDecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(SQLynxProcessor);
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
export const SQLynxDecorations = [ScannerDecorationField, ScannerDecorations, FocusDecorationField, FocusDecorations];
