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
        const completionBuffer = processor.mainScript.completeAtCursor(10);
        const completion = completionBuffer.read(new sqlynx.proto.Completion());
        const candidateObj = new sqlynx.proto.CompletionCandidate();
        for (let i = 0; i < completion.candidatesLength(); ++i) {
            const candidate = completion.candidates(i, candidateObj)!;
            let tagDetail: string | undefined = undefined;
            for (const tag of unpackNameTags(candidate.nameTags())) {
                tagDetail = getNameTagName(tag);
            }
            options.push({
                label: candidate.nameText() ?? '',
                detail: tagDetail,
            });
        }
        offset = processor.scriptCursor.scannerSymbolOffset;
    }

    return {
        from: offset,
        options,
        filter: false,
        update: updateCompletions,
    };
}
