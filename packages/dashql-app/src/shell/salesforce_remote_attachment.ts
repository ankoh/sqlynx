import type { EmbeddedConnection } from '../platform/database/embedded_database.js';
import { generateSchemaSQL } from '../app/notebook/connections/catalog_sql_generator.js';
import type { LoggerLike } from '../platform/logger/logger.js';
import type { DashQLShell } from './api.js';
import type { DashQLScript } from '@ankoh/dashql-core';
import type * as connection from '@ankoh/dashql-jsonschema/connection.js';
import { getSalesforceDataCloudUrl } from '../app/notebook/connections/salesforce/salesforce_api_client.js';

export const SALESFORCE_CATALOG_RANK = 100;
const ENDPOINT_KEY_PREFIX = 'salesforce-';
const HYPER_REMOTE_ENDPOINTS_SETTING = 'global.hyper_remote_endpoints';
const HYPER_REMOTE_GATE = 'global.experimental_dbregistry_hyper_remote';
const LOG_CTX = 'salesforce_remote_attachment';

export interface SalesforceRemoteCatalogColumn {
    readonly name: string;
    readonly ordinalPosition: number;
    readonly dataType?: string | null;
}

export interface SalesforceRemoteCatalogTable {
    readonly name: string;
    readonly columns: readonly SalesforceRemoteCatalogColumn[];
}

export interface SalesforceRemoteCatalog {
    readonly tables: readonly SalesforceRemoteCatalogTable[];
    readonly functionsSQL?: string;
}

export interface SalesforceRemoteAttachment {
    readonly alias: string;
}

export interface SalesforceRemoteAttachmentDependencies {
    loadPrefetchedFunctionSql(signal?: AbortSignal): Promise<string>;
    createEndpointKey?(alias: string): string;
    onStage?(stage: SalesforceRemoteAttachmentStage): void;
    logger?: LoggerLike;
}

export type SalesforceRemoteAttachmentStage =
    | 'CONFIGURING_ENDPOINT'
    | 'ENABLING_REMOTE_DATABASES'
    | 'ATTACHING_DATABASE'
    | 'LOADING_CATALOG';

interface SalesforceRemoteAttachmentState {
    readonly alias: string;
    catalogScript: DashQLScript | null;
}

interface HyperRemoteEndpointConfig {
    readonly connection: {
        readonly host: string;
        readonly port: number;
    };
    readonly tenant: string;
    readonly token: string;
}

export function quoteSqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export function quoteSqlIdentifier(value: string): string {
    if (value.length === 0 || value.includes('\0')) throw new Error('SQL identifier must not be empty or contain NUL');
    return `"${value.replace(/"/g, '""')}"`;
}

function defaultCreateEndpointKey(alias: string): string {
    return `${ENDPOINT_KEY_PREFIX}${alias.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
}

function readEndpoint(token: connection.SalesforceCoreAccessToken, params: Pick<connection.SalesforceConnectionParams, 'dataCloudInstanceUrl' | 'dataCloudTenantId'>): HyperRemoteEndpointConfig {
    const url = new URL(getSalesforceDataCloudUrl(params.dataCloudInstanceUrl));
    const tenant = params.dataCloudTenantId?.trim();
    if (!tenant) throw new Error('Data Cloud Tenant ID cannot be empty');
    if (!token.jwt.raw) throw new Error('Salesforce OrgJWT is missing raw JWT');
    const port = url.port || '443';
    return {
        connection: {
            host: `${url.protocol}//${url.hostname}`,
            port: Number(port),
        },
        tenant,
        token: token.jwt.raw,
    };
}

function summarizeEndpoint(endpoint: HyperRemoteEndpointConfig): Record<string, string> {
    return {
        hostOrigin: endpoint.connection.host,
        port: endpoint.connection.port.toString(),
        tenantPresent: (endpoint.tenant.length > 0).toString(),
        tokenPresent: (endpoint.token.length > 0).toString(),
        tokenPartCount: endpoint.token.split('.').length.toString(),
    };
}

export class SalesforceRemoteAttachmentManager {
    private readonly attachments = new Map<string, SalesforceRemoteAttachmentState>();
    private readonly endpoints = new Map<string, HyperRemoteEndpointConfig>();
    private functionCatalogLoaded = false;
    private gateEnabled = false;

    constructor(
        private readonly connection: EmbeddedConnection,
        private readonly shell: Pick<DashQLShell, 'loadCatalogScript' | 'replaceCatalogScript'>,
        private readonly dependencies: SalesforceRemoteAttachmentDependencies,
    ) {}

    hasAlias(alias: string): boolean {
        return this.attachments.has(alias.toLowerCase());
    }

    getAliases(): readonly string[] {
        return Array.from(this.attachments.values(), attachment => attachment.alias);
    }

    async attach(
        alias: string,
        token: connection.SalesforceCoreAccessToken,
        params: Pick<connection.SalesforceConnectionParams, 'dataCloudInstanceUrl' | 'dataCloudTenantId'>,
        signal?: AbortSignal,
    ): Promise<SalesforceRemoteAttachment> {
        signal?.throwIfAborted();
        const normalizedAlias = alias.toLowerCase();
        if (this.attachments.has(normalizedAlias)) throw new Error(`Salesforce alias already exists: ${alias}`);

        const endpointKey = (this.dependencies.createEndpointKey ?? defaultCreateEndpointKey)(alias);
        if (this.endpoints.has(endpointKey)) throw new Error(`Salesforce endpoint key already exists: ${endpointKey}`);
        const endpoint = readEndpoint(token, params);
        const nextEndpoints = new Map(this.endpoints);
        nextEndpoints.set(endpointKey, endpoint);
        const previousSetting = this.serializeEndpoints(this.endpoints);
        const nextSetting = this.serializeEndpoints(nextEndpoints);
        const quotedAlias = quoteSqlIdentifier(alias);
        let settingUpdated = false;
        const enabledGate = !this.gateEnabled;
        let attached = false;
        let committed = false;
        const attachStartedAt = performance.now();

        this.logInfo('Starting Salesforce database attachment', {
            alias,
            endpointKey,
            ...summarizeEndpoint(endpoint),
        });

        try {
            this.dependencies.onStage?.('CONFIGURING_ENDPOINT');
            await this.execute(
                `SET ${HYPER_REMOTE_ENDPOINTS_SETTING} = ${quoteSqlString(nextSetting)}`,
                'configure-endpoint',
                { alias, endpointKey, endpointCount: nextEndpoints.size.toString() },
                signal,
            );
            settingUpdated = true;
            this.dependencies.onStage?.('ENABLING_REMOTE_DATABASES');
            await this.execute(
                `SET ${HYPER_REMOTE_GATE} = true`,
                'enable-remote-databases',
                { alias, endpointKey },
                signal,
            );
            this.dependencies.onStage?.('ATTACHING_DATABASE');
            await this.execute(
                `ATTACH DATABASE ${quoteSqlIdentifier(`hyper.remote://${endpointKey}`)} AS ${quotedAlias}`,
                'attach-database',
                { alias, endpointKey },
                signal,
            );
            attached = true;
            this.endpoints.set(endpointKey, endpoint);
            this.attachments.set(normalizedAlias, { alias, catalogScript: null });
            this.gateEnabled = true;
            committed = true;
            this.logInfo('Completed Salesforce database attachment', {
                alias,
                endpointKey,
                elapsedMs: (performance.now() - attachStartedAt).toFixed(0),
            });
            return { alias };
        } catch (error) {
            if (committed) throw error;
            this.logError('Salesforce database attachment failed', {
                alias,
                endpointKey,
                elapsedMs: (performance.now() - attachStartedAt).toFixed(0),
                errorType: error instanceof Error ? error.name : typeof error,
            });
            if (attached) {
                await this.executeBestEffort(`DETACH ${quotedAlias}`, 'rollback-detach', { alias, endpointKey });
            }
            if (settingUpdated) {
                await this.executeBestEffort(
                    `SET ${HYPER_REMOTE_ENDPOINTS_SETTING} = ${quoteSqlString(previousSetting)}`,
                    'rollback-endpoint',
                    { alias, endpointKey, endpointCount: this.endpoints.size.toString() },
                );
            }
            if (enabledGate) {
                await this.executeBestEffort(
                    `SET ${HYPER_REMOTE_GATE} = false`,
                    'rollback-remote-databases',
                    { alias, endpointKey },
                );
            }
            throw error;
        }
    }

    async refreshCatalog(
        alias: string,
        catalog: SalesforceRemoteCatalog,
        signal?: AbortSignal,
    ): Promise<void> {
        signal?.throwIfAborted();
        const attachment = this.attachments.get(alias.toLowerCase());
        if (attachment == null) throw new Error(`Salesforce alias not found: ${alias}`);

        this.dependencies.onStage?.('LOADING_CATALOG');
        const catalogStartedAt = performance.now();
        this.logInfo('Starting Salesforce catalog registration', { alias: attachment.alias });
        if (!this.functionCatalogLoaded) {
            const functionSqlStartedAt = performance.now();
            this.logInfo('Starting Salesforce function catalog resolution', {
                alias: attachment.alias,
                source: catalog.functionsSQL == null ? 'prefetched-fetch' : 'resolved-catalog',
            });
            const functionSql = catalog.functionsSQL ?? await this.dependencies.loadPrefetchedFunctionSql(signal);
            this.logInfo('Completed Salesforce function catalog resolution', {
                alias: attachment.alias,
                elapsedMs: (performance.now() - functionSqlStartedAt).toFixed(0),
                scriptChars: functionSql.length.toString(),
            });
            signal?.throwIfAborted();
            this.shell.loadCatalogScript(functionSql, SALESFORCE_CATALOG_RANK);
            this.functionCatalogLoaded = true;
        }

        const schemaSqlStartedAt = performance.now();
        const tables = new Map(catalog.tables.map(table => [table.name, [...table.columns]]));
        const catalogSql = generateSchemaSQL(attachment.alias, 'public', tables);
        this.logInfo('Completed Salesforce relation catalog generation', {
            alias: attachment.alias,
            elapsedMs: (performance.now() - schemaSqlStartedAt).toFixed(0),
            scriptChars: catalogSql.length.toString(),
        });
        signal?.throwIfAborted();
        if (attachment.catalogScript == null) {
            attachment.catalogScript = this.shell.loadCatalogScript(catalogSql, SALESFORCE_CATALOG_RANK);
        } else {
            this.shell.replaceCatalogScript(attachment.catalogScript, catalogSql, SALESFORCE_CATALOG_RANK);
        }
        this.logInfo('Completed Salesforce catalog registration', {
            alias: attachment.alias,
            elapsedMs: (performance.now() - catalogStartedAt).toFixed(0),
        });
    }

    private serializeEndpoints(endpoints: ReadonlyMap<string, HyperRemoteEndpointConfig>): string {
        return JSON.stringify(Object.fromEntries(endpoints));
    }

    private async execute(
        sql: string,
        operation: string,
        keyValues: Record<string, string>,
        signal?: AbortSignal,
    ): Promise<void> {
        signal?.throwIfAborted();
        const startedAt = performance.now();
        this.logInfo('Starting Salesforce database attach operation', { ...keyValues, operation });
        try {
            await this.connection.queryArrowIPC(sql, signal);
            signal?.throwIfAborted();
            this.logInfo('Completed Salesforce database attach operation', {
                ...keyValues,
                operation,
                elapsedMs: (performance.now() - startedAt).toFixed(0),
            });
        } catch (error) {
            this.logError('Salesforce database attach operation failed', {
                ...keyValues,
                operation,
                elapsedMs: (performance.now() - startedAt).toFixed(0),
                errorType: error instanceof Error ? error.name : typeof error,
            });
            throw error;
        }
    }

    private async executeBestEffort(
        sql: string,
        operation: string,
        keyValues: Record<string, string>,
    ): Promise<void> {
        const startedAt = performance.now();
        this.logInfo('Starting Salesforce database attach rollback', { ...keyValues, operation });
        try {
            await this.connection.queryArrowIPC(sql);
            this.logInfo('Completed Salesforce database attach rollback', {
                ...keyValues,
                operation,
                elapsedMs: (performance.now() - startedAt).toFixed(0),
            });
        } catch (error) {
            this.logError('Salesforce database attach rollback failed', {
                ...keyValues,
                operation,
                elapsedMs: (performance.now() - startedAt).toFixed(0),
                errorType: error instanceof Error ? error.name : typeof error,
            });
            // Preserve the original failure while attempting to restore runtime state.
        }
    }

    private logInfo(message: string, keyValues: Record<string, string>): void {
        this.dependencies.logger?.info(message, keyValues, LOG_CTX);
    }

    private logError(message: string, keyValues: Record<string, string>): void {
        this.dependencies.logger?.error(message, keyValues, LOG_CTX);
    }
}
