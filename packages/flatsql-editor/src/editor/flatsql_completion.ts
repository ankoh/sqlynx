import * as flatsql from '@ankoh/flatsql';

import { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { FlatSQLProcessor } from './flatsql_processor';

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
export async function completeFlatSQL(context: CompletionContext): Promise<CompletionResult> {
    const processor = context.state.field(FlatSQLProcessor);
    const options: Completion[] = [];

    if (processor.mainScript !== null) {
        const completionBuffer = processor.mainScript.completeAtCursor(10);
        const completion = completionBuffer.read(new flatsql.proto.Completion());
        const candidateObj = new flatsql.proto.CompletionCandidate();
        for (let i = 0; i < completion.candidatesLength(); ++i) {
            const candidate = completion.candidates(i, candidateObj)!;
            options.push({
                label: candidate.nameText() ?? '',
                type: 'keyword',
            });
        }
    }

    return {
        from: context.pos,
        options,
        filter: false,
        update: updateCompletions,
    };
}
