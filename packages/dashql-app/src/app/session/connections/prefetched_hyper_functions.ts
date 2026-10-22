import * as dashql from '@ankoh/dashql-core';

import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK } from './catalog_update_state.js';
import { generateFunctionScriptHeader } from './catalog_function_sql_generator.js';
import { CatalogSource } from './catalog_sql_generator.js';
import { publishCatalogBatchSync } from './catalog_batch.js';

import prefetchedHyperFunctionsSql from '../../../../static/catalog/hyper/dashql-catalog-functions.sql?raw';

export const PREFETCHED_HYPER_FUNCTIONS_SQL = prefetchedHyperFunctionsSql;

export function qualifyPrefetchedHyperFunctions(databaseName: string, updatedAt: Date = new Date()): string {
    const quotedDatabase = `"${databaseName.replace(/"/g, '""')}"`;
    const functions = PREFETCHED_HYPER_FUNCTIONS_SQL.replace(
        /"hyper"\./g,
        `${quotedDatabase}.`,
    );
    return `${generateFunctionScriptHeader(CatalogSource.Hyper, updatedAt)}${functions}`;
}

export async function fetchPrefetchedHyperFunctions(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return PREFETCHED_HYPER_FUNCTIONS_SQL;
}

export function loadPrefetchedHyperFunctions(
    dql: dashql.DashQL,
    catalog: dashql.DashQLCatalog,
    catalogFunctionScript: dashql.DashQLScript,
    sql: string,
    rank = CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK,
): number {
    return publishCatalogBatchSync(dql, catalog, [{
        script: catalogFunctionScript, text: sql, rank, requireFunctions: true,
    }])[0].functions;
}
