import { AtlasSql, vectorLiteral } from '../atlas_sql.js';
import { externalTable, type AtlasLocation } from '../store.js';

export interface SearchHit {
    scriptName: string;
    /// Cosine similarity, the embeddings are L2-normalized
    score: number;
    /// What matched: the best comment chunk, or the features of the script
    snippet: string;
}

export interface SearchStrategy {
    id: string;
    title: string;
    run(sql: AtlasSql, location: AtlasLocation, query: Float32Array, limit: number): Promise<SearchHit[]>;
}

function asNumber(value: unknown): number {
    return typeof value === 'bigint' ? Number(value) : Number(value);
}

function asStrings(value: unknown): string[] {
    if (value == null) return [];
    const items = typeof (value as { toArray?: unknown }).toArray === 'function'
        ? (value as { toArray(): Iterable<unknown> }).toArray()
        : (value as Iterable<unknown>);
    return Array.from(items, v => String(v));
}

/// The best comment chunk of every script against the query
export const COMMENT_SEARCH: SearchStrategy = {
    id: 'comments',
    title: 'Comments',
    async run(sql, location, query, limit) {
        const vector = vectorLiteral(query);
        const table = await sql.query('Search comments', `
SELECT script_name, text, score FROM (
    SELECT script_name, text, dot_product(embedding, ${vector}) AS score,
        row_number() OVER (PARTITION BY script_name ORDER BY dot_product(embedding, ${vector}) DESC) AS rank
    FROM ${externalTable(location.commentsPath)}
) ranked
WHERE rank = 1
ORDER BY score DESC
LIMIT ${Math.trunc(limit)}`);
        return table.toArray().map(row => ({
            scriptName: String(row.script_name),
            score: asNumber(row.score),
            snippet: String(row.text),
        }));
    },
};

/// The script features (tables, joins, functions, ...) against the query
export const FEATURE_SEARCH: SearchStrategy = {
    id: 'features',
    title: 'Features',
    async run(sql, location, query, limit) {
        const table = await sql.query('Search features', `
SELECT script_name, tables, function_calls, dot_product(embedding, ${vectorLiteral(query)}) AS score
FROM ${externalTable(location.featuresPath)}
ORDER BY score DESC
LIMIT ${Math.trunc(limit)}`);
        return table.toArray().map(row => {
            const parts: string[] = [];
            const tables = asStrings(row.tables);
            const calls = asStrings(row.function_calls);
            if (tables.length > 0) parts.push(`Tables: ${tables.join(', ')}`);
            if (calls.length > 0) parts.push(`Calls: ${calls.slice(0, 6).join(', ')}`);
            return { scriptName: String(row.script_name), score: asNumber(row.score), snippet: parts.join('\n') };
        });
    },
};

/// More strategies plug in here
export const SEARCH_STRATEGIES: readonly SearchStrategy[] = [COMMENT_SEARCH, FEATURE_SEARCH];

export interface SearchResults {
    strategy: SearchStrategy;
    hits: SearchHit[];
}

/// Embed nothing here, callers pass the query vector so that every strategy sees the same one
export async function searchAll(
    sql: AtlasSql,
    location: AtlasLocation,
    query: Float32Array,
    limit = 5,
    strategies: readonly SearchStrategy[] = SEARCH_STRATEGIES,
): Promise<SearchResults[]> {
    const out: SearchResults[] = [];
    for (const strategy of strategies) {
        out.push({ strategy, hits: await strategy.run(sql, location, query, limit) });
    }
    return out;
}
