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
