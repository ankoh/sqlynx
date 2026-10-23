import * as React from 'react';

import * as connectionTypes from '@ankoh/dashql-jsonschema/connection.js';

import type { EmbeddedConnection } from '../platform/database/embedded_database.js';
import type { EmbeddedExternalDirectoryDatabase, EmbeddedExternalFileDatabase } from '../platform/database/embedded_database.js';
import { useEmbeddedDatabaseSetup } from '../platform/database/embedded_database_provider.js';
import { stringifyError } from '../platform/logger/logger.js';
import { useLogger } from '../platform/logger/logger_provider.js';
import { createDashQLShell, type DashQLShell, type DashQLShellCommand } from '../shell/api.js';
import type { BrowserShellController } from '../shell/browser_shell.js';
import { analyzeTable } from '../compute/computation_logic.js';
import { useComputationDispatch } from '../compute/computation_registry.js';
import { ShellQueryResultOverlay } from '../app/session/shell/shell_query_result_overlay.js';
import { createEmbeddedDatabaseShellEnvironment } from './embedded_database_shell_environment.js';
import { createLoginCommand, type SalesforceLoginAuthentication } from './commands/login.js';
import { SalesforceLoginHistoryStore } from './salesforce_login_history.js';
import { examplesCommand } from './commands/examples.js';
import { useShellQueryHistory } from './shell_query_history.js';
import { createShellOutputCommand, type ShellOutputMode } from '../shell/shell_result.js';
import {
    createShellFilesCommand,
    selectPlatformDirectory,
    selectPlatformFiles,
    ShellFileRegistry,
} from '../shell/shell_files.js';
import { useMountDialog } from './filesystem_mount_dialog.js';
import { useFilesystemDialog } from './filesystem_dialog.js';
import { createFormatCommand } from './commands/format.js';
import { createPlanCommand } from './commands/plan.js';
import { createShareCommand } from './commands/share.js';
import { useSalesforceLoginDialog } from './salesforce_login_dialog.js';
import { SalesforceApiClient } from '../app/connections/salesforce/salesforce_api_client.js';
import { authenticateSalesforce } from '../app/connections/salesforce/salesforce_authentication.js';
import { useHttpClient } from '../platform/http/http_client_provider.js';
import { usePlatformEventListener } from '../platform/events/event_listener_provider.js';
import { PlatformType, usePlatformType } from '../platform/platform_type.js';
import { useAppConfig } from '../app/config/app_config.js';
import { getKeywordCase } from '../app/session/ui/script_format.js';
import { useShellQueryResult } from './use_shell_query_result.js';
import { useFormatDialog } from './format_dialog.js';
import { usePlanDialog } from './plan_dialog.js';
import { useShareDialog } from './share_dialog.js';
import { decodeShareScript, readShareScriptFromLocation, splitShareScript } from './shell_share.js';
import { getHyperDBWebSupportError } from '../platform/hyperdb/hyperdb_web_support.js';
import * as styles from './shell_page.module.css';

const LOG_CTX = 'standalone_shell';

function externalFileDatabase(database: unknown): EmbeddedExternalFileDatabase | undefined {
    if (database == null || typeof database !== 'object') return undefined;
    if (!('registerExternalFile' in database) || !('removeExternalFile' in database)) return undefined;
    return database as EmbeddedExternalFileDatabase;
}

function externalDirectoryDatabase(database: unknown): EmbeddedExternalDirectoryDatabase | undefined {
    if (database == null || typeof database !== 'object') return undefined;
    if (!('registerExternalDirectory' in database) || !('removeExternalDirectory' in database)) return undefined;
    return database as EmbeddedExternalDirectoryDatabase;
}

interface ShellPageProps {
    onEngineVersion: (version: string) => void;
}

function formatInstantiationProgress(bytesLoaded: number, bytesTotal: number): string {
    if (bytesTotal <= 0) return `Loading ${Math.round(bytesLoaded / 1000)} kB`;
    const blocks = Math.max(0, Math.min(10, Math.floor(bytesLoaded / bytesTotal * 10)));
    return `Loading [${'#'.repeat(blocks)}${'-'.repeat(10 - blocks)}]`;
}

export const ShellPage: React.FC<ShellPageProps> = (props: ShellPageProps) => {
    const logger = useLogger();
    const setupEmbeddedDatabase = useEmbeddedDatabaseSetup();
    const queryExecutions = useShellQueryHistory();
    const dispatchComputation = useComputationDispatch();
    const httpClient = useHttpClient();
    const appEvents = usePlatformEventListener();
    const platformType = usePlatformType();
    const appConfig = useAppConfig();
    const keywordCase = getKeywordCase(appConfig?.settings);
    const hyperDBSupportError = platformType === PlatformType.WEB ? getHyperDBWebSupportError() : null;
    const keywordCaseRef = React.useRef(keywordCase);
    keywordCaseRef.current = keywordCase;
    // The login reads the config when it runs, a config that arrives later must not tear down the shell
    const appConfigRef = React.useRef(appConfig);
    appConfigRef.current = appConfig;
    const loginHistoryRef = React.useRef(new SalesforceLoginHistoryStore());
    const { controller: loginDialog, dialog } = useSalesforceLoginDialog({
        nativeOAuth: platformType !== PlatformType.WEB,
        loadHistory: () => loginHistoryRef.current.load(),
        deleteHistoryEntry: organizationId => loginHistoryRef.current.delete(organizationId),
    });
    const { controller: formatDialog, dialog: formatterDialog } = useFormatDialog();
    const { controller: planDialog, dialog: queryPlanDialog } = usePlanDialog(appEvents);
    const { controller: shareDialog, dialog: shareScriptDialog } = useShareDialog();
    const fileRegistryRef = React.useRef<ShellFileRegistry | null>(null);
    const { controller: mountDialog, dialog: mountDialogOverlay } = useMountDialog({
        selectFiles: async signal => {
            const files = await selectPlatformFiles(signal);
            if (files.length === 0) return null;
            if (files.length !== 1) throw new Error('select exactly one file to choose a mount path');
            return { kind: 'file', name: files[0].path, file: files[0] };
        },
        selectDirectory: async (mode, signal) => {
            const handle = await selectPlatformDirectory(mode);
            return { kind: 'directory', name: handle.name, handle, mode };
        },
        mount: async (selection, path, signal) => {
            const registry = fileRegistryRef.current;
            if (registry == null) throw new Error('Filesystem mounting is not ready');
            return selection.kind === 'file'
                ? await registry.mountFile(selection.file, path, { signal })
                : await registry.mountDirectory(selection.handle, path, selection.mode);
        },
    });
    const { controller: filesystemDialog, dialog: filesystemDialogOverlay } = useFilesystemDialog({
        list: async () => fileRegistryRef.current?.listFiles() ?? [],
        unlink: async path => {
            const registry = fileRegistryRef.current;
            if (registry == null || !await registry.drop(path)) throw new Error(`filesystem entry not registered: ${path}`);
        },
        mount: mountDialog.request,
    });
    const containerRef = React.useRef<HTMLDivElement>(null);
    const outputModeRef = React.useRef<ShellOutputMode>('auto');
    const terminalColumnsRef = React.useRef(100);
    const [status, setStatus] = React.useState('Instantiating hyperdb-wasm');
    const shellRef = React.useRef<DashQLShell | null>(null);
    React.useEffect(() => {
        shellRef.current?.setKeywordCase(keywordCase);
    }, [keywordCase]);
    const { resultQuery, showResultQuery, closeResultQuery } = useShellQueryResult(queryExecutions);

    React.useEffect(() => {
        if (hyperDBSupportError != null) return;
        if (containerRef.current == null) return;

        let cancelled = false;
        let connection: EmbeddedConnection | null = null;
        let shell: DashQLShell | null = null;
        let controller: BrowserShellController | null = null;
        let fileRegistry: ShellFileRegistry | null = null;

        const setup = async () => {
            setStatus('Instantiating hyperdb-wasm');
            const database = await setupEmbeddedDatabase(LOG_CTX, progress => {
                if (!cancelled) {
                    setStatus(`Instantiating hyperdb-wasm: ${formatInstantiationProgress(progress.bytesLoaded, progress.bytesTotal)}`);
                }
            });
            void database.getVersion()
                .then(version => {
                    if (!cancelled) props.onEngineVersion(version);
                })
                .catch(error => {
                    logger.warn('Failed to load engine version', { error: stringifyError(error) }, LOG_CTX);
                });
            const nextConnection = await database.connect({ defaultDatabase: 'hyper' });
            if (cancelled) {
                await nextConnection.close();
                return;
            }
            connection = nextConnection;

            setStatus('Instantiating shell');
            const getOutputMode = () => outputModeRef.current;
            const loginCommand = createLoginCommand({
                requestForm: loginDialog.request,
                authenticate: async (form, signal, onProgress) => {
                    if (!httpClient) throw new Error('HTTP client is not ready');
                    const oauthRedirect = appConfigRef.current?.connectors?.salesforce?.auth?.oauthRedirect;
                    if (!oauthRedirect) throw new Error('Salesforce OAuth redirect is not configured');
                    const abortSignal = signal ?? new AbortController().signal;
                    const params: connectionTypes.SalesforceConnectionParams = {
                        hyperProtocol: 'WASM',
                        instanceUrl: form.instanceUrl,
                        appConsumerKey: form.appConsumerKey,
                        appConsumerSecret: '',
                        login: form.loginHint,
                    };
                    return await authenticateSalesforce({
                        logger,
                        params,
                        authConfig: { oauthRedirect },
                        platformType,
                        apiClient: new SalesforceApiClient(logger, httpClient),
                        appEvents,
                        forceReLogin: appConfigRef.current?.settings?.forceReLogin ?? false,
                        abortSignal,
                        oauthPopup: form.oauthPopup,
                        onProgress: progress => {
                            const messages: Partial<Record<typeof progress.stage, string>> = {
                                GENERATING_PKCE_CHALLENGE: 'Preparing secure Salesforce login',
                                OAUTH_NATIVE_LINK_OPENED: 'Waiting for Salesforce authorization in your browser',
                                OAUTH_WEB_WINDOW_OPENED: 'Waiting for Salesforce authorization',
                                REQUESTING_CORE_AUTH_TOKEN: 'Exchanging Salesforce authorization code',
                                REQUESTING_DATA_CLOUD_ACCESS_TOKEN: 'Requesting Data Cloud credentials',
                            };
                            const message = messages[progress.stage];
                            if (message) {
                                onProgress?.(message);
                                loginDialog.update({ status: message });
                            }
                            if (progress.stage === 'RECEIVED_CORE_AUTH_TOKEN') {
                                loginDialog.update({
                                    status: 'Received Core access token',
                                    coreAccessToken: progress.coreAccessToken,
                                });
                            } else if (progress.stage === 'RECEIVED_CORE_USER_INFO') {
                                loginDialog.update({
                                    login: progress.coreUserInfo.preferredUsername ?? progress.coreUserInfo.email ?? '',
                                });
                            } else if (progress.stage === 'RECEIVED_DATA_CLOUD_ACCESS_TOKEN') {
                                loginDialog.update({
                                    status: 'Received Data Cloud access token',
                                    dataCloudAccessToken: progress.dataCloudAccessToken,
                                });
                            }
                        },
                    });
                },
                onSuccess: async (form, authentication) => {
                    const organizationId = authentication.coreUserInfo?.organizationId
                        ?? authentication.dataCloudAccessToken.jwt.payload.orgId;
                    if (organizationId) {
                        try {
                            await loginHistoryRef.current.record({
                                organizationId,
                                name: form.alias,
                                instanceUrl: authentication.coreAccessToken.instanceUrl ?? form.instanceUrl,
                                appConsumerKey: form.appConsumerKey,
                                loginHint: authentication.coreUserInfo?.preferredUsername
                                    ?? authentication.coreUserInfo?.email,
                            });
                        } catch (error) {
                            logger.warn('Failed to persist Salesforce login history', {
                                error: stringifyError(error),
                            }, LOG_CTX);
                        }
                    } else {
                        logger.warn('Salesforce login did not return an organization ID; history was not updated', {}, LOG_CTX);
                    }
                    loginDialog.succeed(`Authenticated with Salesforce as ${form.alias}`);
                },
                onError: error => {
                    loginDialog.fail(stringifyError(error));
                    return 'retry';
                },
            });
            fileRegistry = new ShellFileRegistry(
                logger,
                externalFileDatabase(database),
                externalDirectoryDatabase(database),
            );
            fileRegistryRef.current = fileRegistry;
            const commands: DashQLShellCommand[] = [
                examplesCommand,
                createFormatCommand({
                    requestDialog: signal => {
                        if (shell == null) throw new Error('Shell is not ready');
                        return formatDialog.request(shell.core, shell.catalog, signal);
                    },
                }),
                createPlanCommand({
                    requestDialog: signal => {
                        if (shell == null) throw new Error('Shell is not ready');
                        return planDialog.request(shell.core, signal);
                    },
                }),
                createShareCommand({
                    requestDialog: signal => {
                        if (shell == null) throw new Error('Shell is not ready');
                        return shareDialog.request(shell.core, shell.catalog, signal);
                    },
                }),
                loginCommand,
                createShellOutputCommand(getOutputMode, mode => { outputModeRef.current = mode; }),
                createShellFilesCommand(fileRegistry, mountDialog.request, filesystemDialog.request),
            ];
            const nextShell = await createDashQLShell({
                environment: createEmbeddedDatabaseShellEnvironment(connection, queryExecutions, {
                    getOutputMode,
                    getTerminalColumns: () => terminalColumnsRef.current,
                    prepareResult: (queryId, table) => analyzeTable(
                        queryId,
                        table,
                        dispatchComputation,
                        database,
                        logger,
                    ),
                }),
                trackSessionRelations: true,
                autoQualifyNonDefaultDatabaseTables: true,
                commands,
                onProgress: progress => {
                    if (!cancelled) {
                        setStatus(`Instantiating shell: ${formatInstantiationProgress(progress.bytesLoaded, progress.bytesTotal)}`);
                    }
                },
            });
            if (cancelled || containerRef.current == null) {
                nextShell.destroy();
                return;
            }
            shell = nextShell;
            shellRef.current = nextShell;
            nextShell.setKeywordCase(keywordCaseRef.current);
            const { embedDashQLShell } = await import('../shell/browser_shell.js');
            if (cancelled || containerRef.current == null) return;
            const nextController = await embedDashQLShell({
                container: containerRef.current,
                shell,
                greeter: [
                    'HyperDB Web Shell',
                    'This is an embedded version of the Hyper Database Engine.',
                    'Enter .help for usage hints.'
                ],
                prompt: 'hyperdb> ',
                inputAriaLabel: 'HyperDB shell input',
                onQueryResult: showResultQuery,
                onTerminalResize: columns => { terminalColumnsRef.current = columns; },
            });
            if (cancelled) {
                nextController.dispose();
                return;
            }
            controller = nextController;
            setStatus('');

            // Offer the statements of a shared script one after another
            const sharedScript = readShareScriptFromLocation();
            if (sharedScript == null) return;
            try {
                const text = await decodeShareScript(sharedScript);
                if (cancelled) return;
                const prompts = splitShareScript(nextShell.core, nextShell.catalog, text);
                if (prompts.length === 0) return;
                nextController.writeStatus(`Shared script with ${prompts.length} ${prompts.length === 1 ? 'statement' : 'statements'}. Press Enter to run each, Ctrl+C to skip the rest.`);
                nextController.queuePrompts(prompts);
            } catch (error) {
                if (cancelled) return;
                logger.warn('Failed to load shared script', { error: stringifyError(error) }, LOG_CTX);
                nextController.writeStatus(`Failed to load shared script: ${stringifyError(error)}`);
            }
        };

        void setup().catch(error => {
            if (cancelled) return;
            const message = `Failed to load shell: ${stringifyError(error)}`;
            logger.warn(message, {}, LOG_CTX);
            setStatus(message);
        });

        return () => {
            cancelled = true;
            controller?.dispose();
            shell?.destroy();
            shellRef.current = null;
            fileRegistryRef.current = null;
            void fileRegistry?.dispose().finally(() => connection?.close());
        };
    }, [appEvents, dispatchComputation, formatDialog, httpClient, hyperDBSupportError, logger, loginDialog, planDialog, platformType, props.onEngineVersion, queryExecutions, setupEmbeddedDatabase, shareDialog, showResultQuery]);

    if (hyperDBSupportError != null) {
        return (
            <main className={styles.page} aria-label="HyperDB Shell">
                <section className={styles.unsupported} role="alert">
                    <h1>Unsupported platform</h1>
                    <p>{hyperDBSupportError}</p>
                </section>
            </main>
        );
    }

    return (
        <main className={styles.page} aria-label="HyperDB Shell">
            <div className={styles.terminal}>
                <div ref={containerRef} className={styles.terminalHost} />
            </div>
            {status && (
                <div className={styles.status} role="status" aria-live="polite">
                    <strong>[ RUN ]</strong> {status}
                </div>
            )}
            {resultQuery != null && (
                <ShellQueryResultOverlay
                    query={resultQuery}
                    onClose={closeResultQuery}
                    dismissOnClickOutside={false}
                />
            )}
            {dialog}
            {formatterDialog}
            {queryPlanDialog}
            {shareScriptDialog}
            {mountDialogOverlay}
            {filesystemDialogOverlay}
        </main>
    );
};
