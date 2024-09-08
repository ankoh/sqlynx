import * as sqlynx from '@ankoh/sqlynx-core';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { EditorState, Transaction, StateField, RangeSetBuilder } from '@codemirror/state';
import { highlightingFor } from '@codemirror/language';
import { tags as CODEMIRROR_TAGS, Tag } from '@lezer/highlight';

import { SQLynxProcessor, SQLynxScriptBuffers, SQLynxScriptKey } from './sqlynx_processor.js';

import './sqlynx_decorations.css';
import { DerivedFocus } from 'session/focus.js';

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
                destroy: () => { },
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
    _scriptCursor: sqlynx.proto.ScriptCursorT | null,
    derivedFocus: DerivedFocus | null,
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const scanned = scriptBuffers.scanned?.read() ?? null;
    const parsed = scriptBuffers.parsed?.read() ?? null;
    const analyzed = scriptBuffers.analyzed?.read() ?? null;
    const decorations: DecorationInfo[] = [];

    if (parsed === null || analyzed === null) {
        return builder.finish();
    }
    const tmpNamedExpr = new sqlynx.proto.Expression();
    const tmpTblRef = new sqlynx.proto.TableReference();
    const tmpNode = new sqlynx.proto.Node();
    const tmpLoc = new sqlynx.proto.Location();
    const tmpError = new sqlynx.proto.Error();

    // Build decorations for related column refs discovered through a table
    if (derivedFocus?.columnRefsOfReferencedTable) {
        for (const refId of derivedFocus.columnRefsOfReferencedTable) {
            const externalId = sqlynx.ExternalObjectID.getExternalID(refId);
            const objectId = sqlynx.ExternalObjectID.getObjectID(refId);
            if (externalId !== scriptKey) {
                continue;
            }
            // XXX invalidate focused table refs at write front
            if (objectId >= analyzed.expressionsLength()) {
                continue;
            }
            const expr = analyzed.expressions(objectId, tmpNamedExpr)!;
            const astNodeId = expr.astNodeId()!;
            const astNode = parsed.nodes(astNodeId, tmpNode)!;
            const loc = astNode.location(tmpLoc)!;
            decorations.push({
                from: loc.offset(),
                to: loc.offset() + loc.length(),
                decoration: FocusedColumnReferenceDecoration, // XXX more specific
            });
        }
    }

    // Build decorations for related column refs discovered through a column
    if (derivedFocus?.columnRefsOfReferencedColumn) {
        for (const refId of derivedFocus.columnRefsOfReferencedColumn) {
            const externalId = sqlynx.ExternalObjectID.getExternalID(refId);
            const objectId = sqlynx.ExternalObjectID.getObjectID(refId);
            if (externalId !== scriptKey) {
                continue;
            }
            // XXX invalidate focused table refs at write front
            if (objectId >= analyzed.expressionsLength()) {
                continue;
            }
            const expr = analyzed.expressions(objectId, tmpNamedExpr)!;
            const astNodeId = expr.astNodeId()!;
            const astNode = parsed.nodes(astNodeId, tmpNode)!;
            const loc = astNode.location(tmpLoc)!;
            decorations.push({
                from: loc.offset(),
                to: loc.offset() + loc.length(),
                decoration: FocusedColumnReferenceDecoration,
            });
        }
    }

    // Build decorations for query_result refs
    if (derivedFocus?.tableRefsOfReferencedTable) {
        for (const refId of derivedFocus.tableRefsOfReferencedTable) {
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
    scriptCursor: sqlynx.proto.ScriptCursorT | null;
    derivedFocus: DerivedFocus | null;
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
                destroy: () => { },
            },
            scriptCursor: null,
            derivedFocus: null,
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
            processor.derivedFocus === state.derivedFocus
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
        s.derivedFocus = processor.derivedFocus;
        s.decorations = buildDecorationsFromCursor(
            s.scriptKey,
            s.scriptBuffers,
            s.scriptCursor,
            s.derivedFocus,
        );
        return s;
    },
});

const ScannerDecorations = EditorView.decorations.from(ScannerDecorationField, state => state.decorations);
const FocusDecorations = EditorView.decorations.from(FocusDecorationField, state => state.decorations);

/// Bundle the decoration extensions
export const SQLynxDecorations = [ScannerDecorationField, ScannerDecorations, FocusDecorationField, FocusDecorations];
