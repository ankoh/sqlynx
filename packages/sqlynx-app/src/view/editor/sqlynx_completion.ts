import * as sqlynx from '@ankoh/sqlynx-core';

import { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { SQLynxProcessor } from './sqlynx_processor.js';
import { getNameTagName, unpackNameTags } from '../../utils/index.js';

const COMPLETION_LIMIT = 32;

/// A SQLynx completion storing the backing completion buffer and a candidate
interface SQLynxCompletion extends Completion {
    /// The completion buffer
    /// XXX How do we clean this up after the completion ends?
    buffer: sqlynx.FlatBufferPtr<sqlynx.proto.Completion>;
    /// The candidate id
    candidateId: number;
}

/// Update the completions
function updateCompletions(
    _current: CompletionResult,
    _from: number,
    _to: number,
    _context: CompletionContext,
): CompletionResult | null {
    return null;
}

/// Preview a completion candidate
const previewCompletion = (completion: Completion) => {
    console.log({ ...completion });
    return null;
};

/// Derived from this example:
/// https://codemirror.net/examples/autocompletion/
export async function completeSQLynx(context: CompletionContext): Promise<CompletionResult> {
    const processor = context.state.field(SQLynxProcessor);
    const completions: SQLynxCompletion[] = [];

    let offset = context.pos;
    if (processor.targetScript !== null && processor.scriptCursor !== null) {
        const relativePos = processor.scriptCursor.scannerRelativePosition;
        const performCompletion =
            relativePos == sqlynx.proto.RelativeSymbolPosition.BEGIN_OF_SYMBOL ||
            relativePos == sqlynx.proto.RelativeSymbolPosition.MID_OF_SYMBOL ||
            relativePos == sqlynx.proto.RelativeSymbolPosition.END_OF_SYMBOL;
        if (performCompletion) {
            const completionBuffer = processor.targetScript.completeAtCursor(COMPLETION_LIMIT);
            const completion = completionBuffer.read();
            const candidateObj = new sqlynx.proto.CompletionCandidate();
            for (let i = 0; i < completion.candidatesLength(); ++i) {
                const candidate = completion.candidates(i, candidateObj)!;
                let tagName: string | undefined = undefined;
                for (const tag of unpackNameTags(candidate.combinedTags())) {
                    tagName = getNameTagName(tag);
                    break;
                }
                let candidateDetail = tagName;
                if (processor.config.showCompletionDetails) {
                    candidateDetail = `${candidateDetail}, score=${candidate.score()}, near=${candidate.nearCursor()}`;
                }
                completions.push({
                    buffer: completionBuffer,
                    candidateId: i,
                    label: candidate.completionText() ?? '',
                    detail: candidateDetail,
                    info: previewCompletion,
                });
            }
            offset = processor.scriptCursor.scannerSymbolOffset;
        }
    }

    return {
        from: offset,
        options: completions,
        filter: false,
        update: updateCompletions,
    };
}
