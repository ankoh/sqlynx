import type { AnalyzedSql } from './core.js';

const decoder = new TextDecoder();

/// The text of the statements of a script, without the comments between them.
/// Comments inside of a statement are part of its span and stay.
export function statementTexts(sql: AnalyzedSql): string[] {
    const parsed = sql.parsed;
    if (!parsed) {
        return [];
    }
    const out: string[] = [];
    for (let i = 0; i < parsed.statementsLength(); ++i) {
        const span = parsed.statements(i)!.statementSpan();
        if (!span) continue;
        const text = decoder.decode(sql.bytes.subarray(span.offset(), span.offset() + span.length())).trim();
        if (text.length > 0) out.push(text);
    }
    return out;
}
