export type FormatHint = 'array' | 'struct' | 'json' | 'sql' | 'plan' | null;

/// Values can be megabytes large, only look at the first and last characters
const PEEK_WINDOW = 4096;
const PLAN_OPERATOR_KEY = '"operator"';
const SQL_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|EXPLAIN|COPY|SET|BEGIN|COMMIT|ROLLBACK)\b/i;

export function peekFormat(value: string | null): FormatHint {
    if (value == null || value.length < 2) return null;
    const head = value.slice(0, PEEK_WINDOW).trimStart();
    const tail = value.slice(-PEEK_WINDOW).trimEnd();
    const first = head.length > 0 ? head[0] : null;
    const last = tail.length > 0 ? tail[tail.length - 1] : null;
    if ((first === '{' || first === '[') && (last === '}' || last === ']')) {
        // Hyper plans start with the operator of the root, e.g. {"tree":{"operator":...}}
        if (first === '{' && last === '}' && head.includes(PLAN_OPERATOR_KEY)) return 'plan';
        return 'json';
    }
    if (SQL_RE.test(head)) return 'sql';
    return null;
}
