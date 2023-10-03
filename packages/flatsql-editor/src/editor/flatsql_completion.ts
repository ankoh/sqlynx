import { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

function updateCompletions(
    current: CompletionResult,
    from: number,
    to: number,
    context: CompletionContext,
): CompletionResult | null {
    return null;
}

export async function completeFlatSQL(context: CompletionContext): Promise<CompletionResult> {
    return {
        from: context.pos,
        options: [
            { label: 'match', type: 'keyword' },
            { label: 'hello', type: 'variable', info: '(World)' },
            { label: 'magic', type: 'text', apply: '⠁⭒*.✩.*⭒⠁', detail: 'macro' },
        ],
        filter: false,
        update: updateCompletions,
    };
}
