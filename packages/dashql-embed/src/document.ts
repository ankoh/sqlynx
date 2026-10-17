import type { ScriptFeatures } from './analysis/features.js';

export interface FeatureDocument {
    text: string;
    tokenCount: number;
    truncated: boolean;
}

interface Section {
    title: string;
    items: string[];
    separator: string;
}

/// Split identifiers into lowercase terms, dropping single characters (table prefixes like `o_`)
export function identifierTerms(identifiers: string[]): string[] {
    const terms = new Set<string>();
    for (const identifier of identifiers) {
        for (const part of identifier.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)) {
            const term = part.toLowerCase();
            if (term.length > 1 && /[a-z]/.test(term)) terms.add(term);
        }
    }
    return [...terms];
}

function countStatements(types: string[]): string[] {
    const counts = new Map<string, number>();
    for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
    return [...counts].map(([type, n]) => (n > 1 ? `${n} ${type} statements` : `1 ${type} statement`));
}

/// Render the features as a deterministic, natural-language-like text that fits a token budget.
/// Sections are added by priority, lists that do not fit are cut and marked with "(+N more)".
export function renderFeatureDocument(
    features: ScriptFeatures,
    maxTokens: number,
    countTokens: (text: string) => number,
): FeatureDocument {
    const identifiers = [...features.tables, ...features.columns, ...features.outputColumns, ...features.ctes];
    const sections: Section[] = [
        { title: 'Statements', items: countStatements(features.statementTypes), separator: ', ' },
        { title: 'Tables', items: features.tables, separator: ', ' },
        { title: 'Joins', items: features.joins, separator: '; ' },
        { title: 'Function calls', items: features.functionCalls, separator: '; ' },
        { title: 'Grouped by', items: features.groupBy, separator: ', ' },
        { title: 'Filters', items: features.filters, separator: '; ' },
        { title: 'Operators', items: features.operators, separator: ', ' },
        { title: 'Ordered by', items: features.orderBy, separator: ', ' },
        { title: 'Output', items: features.outputColumns, separator: ', ' },
        { title: 'CTEs', items: features.ctes, separator: ', ' },
        { title: 'Columns', items: features.columns, separator: ', ' },
        { title: 'Terms', items: identifierTerms(identifiers), separator: ' ' },
    ].filter(s => s.items.length > 0);

    const lines: string[] = [];
    let truncated = false;
    const render = (title: string, items: string[], separator: string, omitted: number): string =>
        `${title}: ${items.join(separator)}${omitted > 0 ? ` (+${omitted} more)` : ''}`;
    for (const section of sections) {
        const full = render(section.title, section.items, section.separator, 0);
        if (countTokens([...lines, full].join('\n')) <= maxTokens) {
            lines.push(full);
            continue;
        }
        truncated = true;
        // Largest prefix of the items that fits
        let lo = 0;
        let hi = section.items.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            const candidate = render(section.title, section.items.slice(0, mid), section.separator, section.items.length - mid);
            if (countTokens([...lines, candidate].join('\n')) <= maxTokens) lo = mid;
            else hi = mid - 1;
        }
        if (lo > 0) {
            lines.push(render(section.title, section.items.slice(0, lo), section.separator, section.items.length - lo));
        }
    }
    const text = lines.join('\n');
    return { text, tokenCount: countTokens(text), truncated };
}
