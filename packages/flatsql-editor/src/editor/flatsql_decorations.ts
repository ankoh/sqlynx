import * as flatsql from '@ankoh/flatsql';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { Transaction, StateField, RangeSetBuilder } from '@codemirror/state';

import { FlatSQLProcessor } from './flatsql_processor';

import './flatsql_decorations.css';

const TokenType = flatsql.proto.ScannerTokenType;
const KeywordDecoration = Decoration.mark({
    class: 'flatsql-keyword',
});

function buildDecorations(
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript>,
    tmp: flatsql.proto.ScannedScript = new flatsql.proto.ScannedScript(),
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const scan = scanned.read(tmp);
    const tokens = scan.tokens();
    if (tokens && tokens.tokenOffsetsArray()) {
        const tokenOffsets = tokens.tokenOffsetsArray()!;
        const tokenTypes = tokens.tokenTypesArray()!;
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

interface DecorationState {
    decorations: DecorationSet;
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
}

/// An analyzer for FlatSQL scripts
const DecorationBuilder: StateField<DecorationState> = StateField.define<DecorationState>({
    // Create the initial state
    create: () => {
        const config: DecorationState = {
            decorations: new RangeSetBuilder<Decoration>().finish(),
            scanned: null,
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (state: DecorationState, transaction: Transaction) => {
        // Scanned program untouched?
        const processor = transaction.state.field(FlatSQLProcessor);
        if (processor.processed.scanned === state.scanned) {
            return state;
        }
        // Rebuild decorations
        const s = { ...state };
        s.scanned = processor.processed.scanned;
        if (s.scanned) {
            s.decorations = buildDecorations(s.scanned);
        }
        return s;
    },
});
/// Derive the decorations from the builder
const Decorations = EditorView.decorations.from(DecorationBuilder, state => state.decorations);
/// Bundle the decoration extensions
export const FlatSQLDecorations = [DecorationBuilder, Decorations];
