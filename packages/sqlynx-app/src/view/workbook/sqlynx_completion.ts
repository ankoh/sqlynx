import * as sqlynx from '@ankoh/sqlynx-core';

import { EditorView } from '@codemirror/view';
import { ChangeSpec } from '@codemirror/state';
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
    candidate.state.onCompletionPeek(candidate.state.scriptKey, candidate.coreCompletion, candidate.candidateId);
    return null;
};

const applyCompletion = (view: EditorView, completion: Completion, from: number, to: number) => {
    const c = completion as SQLynxCompletion;
    const candidate = c.coreCompletion.candidates[c.candidateId];
    if (!candidate.replaceTextAt) {
        console.warn("candidate replaceTextAt is null");
        return;
    }
    const changes: ChangeSpec[] = [];
    // XXX The location of the trailing to might include eof?
    //     We shouldn't need to clamp here but should rather fix it on the wasm side
    const replaceFrom = Math.min(candidate.replaceTextAt.offset, view.state.doc.length);
    const replaceTo = Math.min(replaceFrom + candidate.replaceTextAt.length, view.state.doc.length);
    changes.push({
        from: replaceFrom,
        to: replaceTo,
        insert: candidate.completionText as string,
    });
    const newCursor = replaceFrom + (candidate.completionText as string).length;
    view.dispatch({ changes, selection: { anchor: newCursor } });
}

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
                for (const tag of unpackNameTags(candidate.nameTags)) {
                    tagName = getNameTagName(tag);
                    break;
                }
                let candidateDetail = tagName;
                if (processor.config.showCompletionDetails) {
                    candidateDetail = `${candidateDetail}, score=${candidate.score}`;
                }
                completions.push({
                    state: processor,
                    coreCompletion: completion,
                    candidateId: i,
                    label: candidate.completionText as string,
                    detail: candidateDetail,
                    info: previewCompletion,
                    apply: applyCompletion,
                });
            }
            offset = processor.scriptCursor.scannerSymbolOffset;
            if (!processor.completionActive) {
                processor.onCompletionStart(processor.scriptKey, completion);
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
