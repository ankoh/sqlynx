import { AtlasSql, quoteIdentifier, vectorLiteral } from '../atlas_sql.js';
import { EMBEDDING_COLUMN } from '../index/tables.js';
import { externalTable, type AtlasLocation } from '../store.js';

export interface SearchHit {
    scriptName: string;
    /// Cosine similarity, the embeddings are L2-normalized
    score: number;
    /// What matched: the best description chunk of the script
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

const EMBEDDING = quoteIdentifier(EMBEDDING_COLUMN);

/// The best description chunk of every script against the query
export const DESCRIPTION_SEARCH: SearchStrategy = {
    id: 'description',
    title: 'Description',
    async run(sql, location, query, limit) {
        const vector = vectorLiteral(query);
        const table = await sql.query('Search descriptions', `
SELECT script_name, description_chunk, score FROM (
    SELECT script_name, description_chunk, dot_product(${EMBEDDING}, ${vector}) AS score,
        row_number() OVER (PARTITION BY script_name ORDER BY dot_product(${EMBEDDING}, ${vector}) DESC) AS rank
    FROM ${externalTable(location.path)}
) ranked
WHERE rank = 1
ORDER BY score DESC
LIMIT ${Math.trunc(limit)}`);
        return table.toArray().map(row => ({
            scriptName: String(row.script_name),
            score: asNumber(row.score),
            snippet: String(row.description_chunk),
        }));
    },
};

/// More strategies plug in here
export const SEARCH_STRATEGIES: readonly SearchStrategy[] = [DESCRIPTION_SEARCH];

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
