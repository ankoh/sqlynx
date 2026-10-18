import { AtlasSql, quoteIdentifier, vectorLiteral } from '../atlas_sql.js';
import { EMBEDDING_COLUMN } from '../index/tables.js';
import { externalTable, type AtlasLocation } from '../store.js';

export interface SearchHit {
    scriptName: string;
    /// Cosine similarity, the embeddings are L2-normalized
    score: number;
    /// What matched: the best description chunk, the structure features or the properties of the script
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

const EMBEDDING = quoteIdentifier(EMBEDDING_COLUMN);

/// The best description chunk of every script against the query
export const DESCRIPTION_SEARCH: SearchStrategy = {
    id: 'description',
    title: 'Description',
    async run(sql, location, query, limit) {
        const vector = vectorLiteral(query);
        const table = await sql.query('Search descriptions', `
SELECT script_name, text, score FROM (
    SELECT script_name, text, dot_product(${EMBEDDING}, ${vector}) AS score,
        row_number() OVER (PARTITION BY script_name ORDER BY dot_product(${EMBEDDING}, ${vector}) DESC) AS rank
    FROM ${externalTable(location.paths.description)}
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

/// The structure features of the scripts (tables, joins, functions, ...) against the query
export const STRUCTURE_SEARCH: SearchStrategy = {
    id: 'structure',
    title: 'Structure',
    async run(sql, location, query, limit) {
        const table = await sql.query('Search structure', `
SELECT script_name, tables, function_calls, dot_product(${EMBEDDING}, ${vectorLiteral(query)}) AS score
FROM ${externalTable(location.paths.structure)}
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

/// The number of properties that a hit shows
const PROPERTIES_SNIPPET_LINES = 4;

/// The user-provided properties of the scripts against the query
export const PROPERTIES_SEARCH: SearchStrategy = {
    id: 'properties',
    title: 'Properties',
    async run(sql, location, query, limit) {
        const table = await sql.query('Search properties', `
SELECT script_name, text, dot_product(${EMBEDDING}, ${vectorLiteral(query)}) AS score
FROM ${externalTable(location.paths.properties)}
ORDER BY score DESC
LIMIT ${Math.trunc(limit)}`);
        return table.toArray().map(row => ({
            scriptName: String(row.script_name),
            score: asNumber(row.score),
            snippet: String(row.text).split('\n').slice(0, PROPERTIES_SNIPPET_LINES).join('\n'),
        }));
    },
};

/// More strategies plug in here
export const SEARCH_STRATEGIES: readonly SearchStrategy[] = [DESCRIPTION_SEARCH, STRUCTURE_SEARCH, PROPERTIES_SEARCH];

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
