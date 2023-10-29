import * as sqlynx from '@ankoh/sqlynx';

import { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { SQLynxProcessor } from './sqlynx_processor';
import { getNameTagName, unpackNameTags } from '../../utils';

function updateCompletions(
    _current: CompletionResult,
    _from: number,
    _to: number,
    _context: CompletionContext,
): CompletionResult | null {
    return null;
}

/// Derived from this example:
/// https://codemirror.net/examples/autocompletion/
export async function completeSQLynx(context: CompletionContext): Promise<CompletionResult> {
    const processor = context.state.field(SQLynxProcessor);
    const options: Completion[] = [];

    let offset = context.pos;
    if (processor.mainScript !== null && processor.scriptCursor !== null) {
        const relativePos = processor.scriptCursor.scannerRelativePosition;
        const performCompletion =
            relativePos == sqlynx.proto.RelativeSymbolPosition.BEGIN_OF_SYMBOL ||
            relativePos == sqlynx.proto.RelativeSymbolPosition.MID_OF_SYMBOL ||
            relativePos == sqlynx.proto.RelativeSymbolPosition.END_OF_SYMBOL;
        if (performCompletion) {
            const completionBuffer = processor.mainScript.completeAtCursor(10);
            const completion = completionBuffer.read(new sqlynx.proto.Completion());
            const candidateObj = new sqlynx.proto.CompletionCandidate();
            for (let i = 0; i < completion.candidatesLength(); ++i) {
                const candidate = completion.candidates(i, candidateObj)!;
                let tagName: string | undefined = undefined;
                for (const tag of unpackNameTags(candidate.nameTags())) {
                    tagName = getNameTagName(tag);
                    break;
                }
                let candidateDetail = tagName;
                if (processor.config.showCompletionDetails) {
                    const score = candidate.score();
                    const inStatment = candidate.inStatement();
                    candidateDetail = `${candidateDetail}, score=${score}, local=${inStatment}`;
                }
                options.push({
                    label: candidate.nameText() ?? '',
                    detail: candidateDetail,
                });
            }
            offset = processor.scriptCursor.scannerSymbolOffset;
        }
    }

    return {
        from: offset,
        options,
        filter: false,
        update: updateCompletions,
    };
}
