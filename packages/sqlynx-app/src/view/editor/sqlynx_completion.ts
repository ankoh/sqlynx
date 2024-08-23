import * as sqlynx from '@ankoh/sqlynx-core';

import { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { getNameTagName, unpackNameTags } from '../../utils/index.js';
import { SQLynxEditorState, SQLynxProcessor } from './sqlynx_processor.js';

const COMPLETION_LIMIT = 32;

/// A SQLynx completion storing the backing completion buffer and a candidate
interface SQLynxCompletion extends Completion {
    /// The processor
    state: SQLynxEditorState;
    /// The completion buffer
    /// XXX How do we clean this up after the completion ends?
    coreCompletion: sqlynx.proto.CompletionT;
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
    const candidate = completion as SQLynxCompletion;
    candidate.state.onCompletionPeek(candidate.coreCompletion, candidate.candidateId);
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
            const completion = completionBuffer.read().unpack();
            completionBuffer.delete();
            for (let i = 0; i < completion.candidates.length; ++i) {
                const candidate = completion.candidates[i];
                let tagName: string | undefined = undefined;
                for (const tag of unpackNameTags(candidate.tags)) {
                    tagName = getNameTagName(tag);
                    break;
                }
                let candidateDetail = tagName;
                if (processor.config.showCompletionDetails) {
                    candidateDetail = `${candidateDetail}, score=${candidate.score}, near=${candidate.nearCursor}`;
                }
                completions.push({
                    state: processor,
                    coreCompletion: completion,
                    candidateId: i,
                    label: candidate.completionText as string,
                    detail: candidateDetail,
                    info: previewCompletion,
                });
            }
            offset = processor.scriptCursor.scannerSymbolOffset;
            if (!processor.completionActive) {
                processor.onCompletionStart(completion);
            }
        }
    }

    return {
        from: offset,
        options: completions,
        filter: false,
        update: updateCompletions,
    };
}
