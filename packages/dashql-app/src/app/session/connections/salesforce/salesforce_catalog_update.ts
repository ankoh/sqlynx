import * as dashql from '@ankoh/dashql-core';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { SalesforceApiClientInterface, type SalesforceMetadataProgress } from './salesforce_api_client.js';
import { getSalesforceDataSpace } from './salesforce_api_client.js';
import { SalesforceConnectionStateDetails } from './salesforce_connection_state.js';
import { generateSchemaSQL, generateCatalogScriptHeader, CatalogSource, type ColumnMetadata } from '../catalog_sql_generator.js';
import { LoggerLike } from '../../../../platform/logger/logger.js';
import { fetchPrefetchedHyperFunctions } from '../prefetched_hyper_functions.js';
import { beginCatalogBatch, publishCatalogBatch, type CatalogBatchOptions } from '../catalog_batch.js';

const SALESFORCE_CATALOG_RANK = 100;
export const SALESFORCE_CATALOG_DATABASE = 'lakehouse';
export const SALESFORCE_CATALOG_SCHEMA = 'public';

export interface ResolvedSalesforceCatalog {
    tables: Map<string, ColumnMetadata[]>;
    functionsSQL: string;
    tableCount: number;
    columnCount: number;
}

export async function resolveSalesforceCatalog(
    logger: LoggerLike,
    coreAccessToken: connection.SalesforceCoreAccessToken,
    dataCloudAccessToken: connection.SalesforceDataCloudAccessToken,
    api: SalesforceApiClientInterface,
    signal: AbortSignal,
    onProgress?: (progress: SalesforceMetadataProgress) => void,
): Promise<ResolvedSalesforceCatalog> {
    if (!coreAccessToken.accessToken || !coreAccessToken.instanceUrl) {
        throw new Error('Salesforce core access token is missing');
    }
    const dataSpace = getSalesforceDataSpace(dataCloudAccessToken);
    logger.info('Resolving Salesforce catalog metadata', { dataSpace }, 'salesforce_catalog');
    const metadataStartedAt = performance.now();
    const [metadata, functionsSQL] = await Promise.all([
        api.getDataCloudMetadata(coreAccessToken, dataSpace, signal, onProgress),
        fetchPrefetchedHyperFunctions(signal),
    ]);
    logger.info('Received Salesforce catalog metadata', {
        dataSpace,
        entities: (metadata.metadata?.length ?? 0).toString(),
        durationMs: (performance.now() - metadataStartedAt).toFixed(2),
    }, 'salesforce_catalog');

    const tables = new Map<string, ColumnMetadata[]>();
    for (const entry of metadata.metadata ?? []) {
        tables.set(entry.name, (entry.fields ?? []).map((field, ordinalPosition) => ({
            name: field.name,
            ordinalPosition,
            dataType: field.type ?? null,
        })));
    }
    const columnCount = Array.from(tables.values()).reduce((total, columns) => total + columns.length, 0);
    if (tables.size === 0 || columnCount === 0) {
        throw new Error('Salesforce metadata returned no usable catalog relations');
    }
    return { tables, functionsSQL, tableCount: tables.size, columnCount };
}

export async function updateSalesforceCatalog(
    logger: LoggerLike,
    conn: SalesforceConnectionStateDetails,
    catalog: dashql.DashQLCatalog,
    dql: dashql.DashQL,
    catalogRelationScript: dashql.DashQLScript,
    catalogFunctionScript: dashql.DashQLScript,
    api: SalesforceApiClientInterface,
    abortController: AbortController,
    options: CatalogBatchOptions = {},
): Promise<dashql.DashQLScript> {
    options = { ...options, abortSignal: abortController.signal };
    const validate = beginCatalogBatch(catalog, options);
    const coreAccessToken = conn.proto.oauthState?.coreAccessToken;
    if (!coreAccessToken?.accessToken || !coreAccessToken.instanceUrl) {
        throw new Error(`Salesforce core access token is missing`);
    }
    if (!conn.proto.oauthState?.dataCloudAccessToken) {
        throw new Error('Salesforce data cloud access token is missing');
    }
    const dataSpace = getSalesforceDataSpace(conn.proto.oauthState.dataCloudAccessToken);
    const { tables, functionsSQL, columnCount } = await resolveSalesforceCatalog(
        logger,
        coreAccessToken,
        conn.proto.oauthState.dataCloudAccessToken,
        api,
        abortController.signal,
    );
    validate();

    // Generate SQL from metadata
    const header = generateCatalogScriptHeader(CatalogSource.SalesforceMetadataApi);
    const catalogSQL = generateSchemaSQL(SALESFORCE_CATALOG_DATABASE, SALESFORCE_CATALOG_SCHEMA, tables);
    logger.info("Generated Salesforce catalog script", {
        dataSpace,
        tables: tables.size.toString(),
        columns: columnCount.toString(),
        scriptBytes: new TextEncoder().encode(catalogSQL).byteLength.toString(),
    }, "salesforce_catalog");

    const [relations, functions] = await publishCatalogBatch(dql, catalog, [
        { script: catalogRelationScript, text: `${header}${catalogSQL}`, rank: SALESFORCE_CATALOG_RANK },
        { script: catalogFunctionScript, text: functionsSQL, rank: SALESFORCE_CATALOG_RANK, requireFunctions: true },
    ], options, validate);
    logger.info("Loaded Salesforce catalog script", {
        dataSpace,
        tables: relations.tables.toString(),
        functions: functions.functions.toString(),
        rank: SALESFORCE_CATALOG_RANK.toString(),
    }, "salesforce_catalog");

    return catalogRelationScript;
}
