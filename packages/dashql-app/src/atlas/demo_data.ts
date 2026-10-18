/// Made up scripts for the dots that show before a folder is open. Everything derives from the dot index, so the same dot
/// always tells the same story.
export interface DemoScript {
    name: string;
    snippet: string;
    tables: string[];
}

const SUBJECTS = [
    'revenue', 'orders', 'customers', 'inventory', 'shipments', 'sessions', 'churn', 'campaigns',
    'tickets', 'invoices', 'suppliers', 'returns', 'signups', 'latency', 'payments', 'forecast',
];
const BREAKDOWNS = ['by_region', 'by_month', 'by_segment', 'by_product', 'per_customer', 'per_week', 'by_channel', 'by_store'];
const SNIPPETS = [
    'Total {s} per {b}, compared with the previous period',
    'Top 10 {s} ranked by volume, filtered to the last quarter',
    'Rolling 7 day average of {s}, grouped by {b}',
    'Joins {s} with the dimension tables and flags outliers',
    'Share of {s} that grew year over year',
];

/// Deterministic mixing of the index into a few independent choices
function mix(index: number, salt: number): number {
    let h = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return (h ^ (h >>> 15)) >>> 0;
}

export function demoScript(index: number): DemoScript {
    const subject = SUBJECTS[mix(index, 1) % SUBJECTS.length];
    const breakdown = BREAKDOWNS[mix(index, 2) % BREAKDOWNS.length];
    const snippet = SNIPPETS[mix(index, 3) % SNIPPETS.length]
        .replace('{s}', subject)
        .replace('{b}', breakdown.replace(/^(by|per)_/, ''));
    const dimension = SUBJECTS[mix(index, 4) % SUBJECTS.length];
    return {
        name: `${subject}_${breakdown}.sql`,
        snippet,
        tables: subject === dimension ? [subject] : [subject, dimension],
    };
}
