import * as flatsql from '@ankoh/flatsql';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { Transaction, StateField, RangeSetBuilder } from '@codemirror/state';

import { FlatSQLProcessor } from './flatsql_processor';

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
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
}

/// Decorations derived from FlatSQL scanner tokens
const ScannerDecorationField: StateField<ScannerDecorationState> = StateField.define<ScannerDecorationState>({
    // Create the initial state
    create: () => {
        const config: ScannerDecorationState = {
            decorations: new RangeSetBuilder<Decoration>().finish(),
            scanned: null,
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (state: ScannerDecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(FlatSQLProcessor);
        if (processor.scriptBuffers.scanned === state.scanned) {
            return state;
        }
        // Rebuild decorations
        const s = { ...state };
        s.scanned = processor.scriptBuffers.scanned;
        if (s.scanned) {
            s.decorations = buildDecorationsFromTokens(s.scanned);
        }
        return s;
    },
});

function buildDecorationsFromCursor(
    scannedBuffer: flatsql.FlatBufferRef<flatsql.proto.ScannedScript>,
    parsedBuffer: flatsql.FlatBufferRef<flatsql.proto.ParsedScript>,
    analyzedBuffer: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript>,
    cursor: flatsql.proto.ScriptCursorInfoT,
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const parsed = parsedBuffer.read(new flatsql.proto.ParsedScript());
    const astNodeId = cursor.astNodeId;

    if (astNodeId < parsed.nodesLength()) {
        const node = parsed.nodes(astNodeId)!;
        const nodeLocation = node.location()!;
        builder.add(
            nodeLocation.offset(),
            nodeLocation.offset() + nodeLocation.length(),
            FocusedTableReferenceDecoration,
        );
    }

    return builder.finish();
}

interface CursorDecorationState {
    decorations: DecorationSet;
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    parsed: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    analyzed: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;
    cursor: flatsql.proto.ScriptCursorInfoT | null;
}

/// Decorations derived from FlatSQL cursor
const CursorDecorationField: StateField<CursorDecorationState> = StateField.define<CursorDecorationState>({
    // Create the initial state
    create: () => {
        const config: CursorDecorationState = {
            decorations: new RangeSetBuilder<Decoration>().finish(),
            scanned: null,
            parsed: null,
            analyzed: null,
            cursor: null,
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (state: CursorDecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(FlatSQLProcessor);
        if (
            processor.scriptBuffers.scanned === state.scanned &&
            processor.scriptBuffers.parsed === state.parsed &&
            processor.scriptBuffers.analyzed === state.analyzed &&
            processor.cursor === state.cursor
        ) {
            return state;
        }
        // Rebuild decorations
        const s = { ...state };
        s.scanned = processor.scriptBuffers.scanned;
        s.parsed = processor.scriptBuffers.parsed;
        s.analyzed = processor.scriptBuffers.analyzed;
        s.cursor = processor.cursor;
        if (s.scanned && s.parsed && s.analyzed && s.cursor) {
            s.decorations = buildDecorationsFromCursor(s.scanned, s.parsed, s.analyzed, s.cursor);
        }
        return s;
    },
});

const ScannerDecorations = EditorView.decorations.from(ScannerDecorationField, state => state.decorations);
const CursorDecorations = EditorView.decorations.from(CursorDecorationField, state => state.decorations);
/// Bundle the decoration extensions
export const FlatSQLDecorations = [
    ScannerDecorationField,
    ScannerDecorations,
    CursorDecorationField,
    CursorDecorations,
];
