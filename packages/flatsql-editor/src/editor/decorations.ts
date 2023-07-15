import * as flatsql from '@ankoh/flatsql';
import { Decoration } from '@codemirror/view';
import { RangeSet, RangeSetBuilder } from '@codemirror/state';

const TokenType = flatsql.proto.HighlightingTokenType;
const KeywordDecoration = Decoration.mark({
    class: 'flatsql-keyword',
});

/// Build CodeMirror decorations
export function buildDecorations(scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript>): RangeSet<Decoration> {
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
