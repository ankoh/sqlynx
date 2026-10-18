import type { StructureFeatures } from './analysis/structure.js';

/// A text to embed that fits the token budget of the model
export interface EmbeddingDocument {
    text: string;
    tokenCount: number;
    truncated: boolean;
}

interface Section {
    title: string;
    items: string[];
    separator: string;
    /// The largest share of the token budget that this section may use on its own
    maxShare?: number;
}

/// A list of tables can be arbitrarily long (generated scripts, wide joins) and tables come early in the priority
/// order. Without a cap, 100 tables would leave nothing for the visualization, joins or filters behind them.
/// A quarter of the budget still lists plenty of tables, the remaining ones are marked with "(+N more)".
const TABLES_MAX_SHARE = 0.25;

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

/// Render the structure features as a deterministic, natural-language-like text that fits a token budget.
/// Sections are added by priority, lists that do not fit are cut and marked with "(+N more)".
/// The budget is checked with the model's own tokenizer, so the text never exceeds it and the model never truncates
/// it silently. Items are the smallest unit that is cut: an item that does not fit on its own is dropped as a whole
/// (never shortened), which is why visualization entries are one per chart and capped in size.
/// A section whose first item does not fit is skipped, smaller sections behind it can still be added.
export function renderStructureDocument(
    features: StructureFeatures,
    maxTokens: number,
    countTokens: (text: string) => number,
): EmbeddingDocument {
    const identifiers = [...features.tables, ...features.columns, ...features.outputColumns, ...features.ctes];
    const sections: Section[] = [
        { title: 'Statements', items: countStatements(features.statementTypes), separator: ', ' },
        { title: 'Tables', items: features.tables, separator: ', ', maxShare: TABLES_MAX_SHARE },
        { title: 'Visualization', items: features.visualizations, separator: '; ' },
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
        const cap = section.maxShare === undefined ? Infinity : Math.floor(maxTokens * section.maxShare);
        // The whole document and, for capped sections, the line itself must fit
        const fits = (line: string): boolean =>
            countTokens([...lines, line].join('\n')) <= maxTokens && (cap === Infinity || countTokens(line) <= cap);
        const full = render(section.title, section.items, section.separator, 0);
        if (fits(full)) {
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
            if (fits(candidate)) lo = mid;
            else hi = mid - 1;
        }
        if (lo > 0) {
            lines.push(render(section.title, section.items.slice(0, lo), section.separator, section.items.length - lo));
        }
    }
    const text = lines.join('\n');
    return { text, tokenCount: countTokens(text), truncated };
}

/// Render user-provided properties as one `key: value` line per property, in the order of the JSON object.
/// Plain lines embed better than JSON punctuation. Strings are written as they are, other values as compact JSON.
/// Properties are added until the token budget is used up, a property that does not fit is dropped as a whole.
export function renderPropertiesDocument(
    properties: Record<string, unknown>,
    maxTokens: number,
    countTokens: (text: string) => number,
): EmbeddingDocument {
    const lines: string[] = [];
    let truncated = false;
    for (const [key, value] of Object.entries(properties)) {
        if (value == null) continue;
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        const line = `${key}: ${rendered.replace(/\s+/g, ' ').trim()}`;
        if (countTokens([...lines, line].join('\n')) > maxTokens) {
            truncated = true;
            continue;
        }
        lines.push(line);
    }
    const text = lines.join('\n');
    return { text, tokenCount: countTokens(text), truncated };
}
