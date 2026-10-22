import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter, HashRouter, useLocation } from 'react-router-dom';

import { AppConfigProvider } from './config/app_config.js';
import { AppLoader } from './loading/app_loader.js';
import { AppSettingsSync } from './config/app_settings_sync.js';
import { CatalogLoaderProvider } from './session/connections/catalog_loader.js';
import { ComputationRegistry } from '../compute/computation_registry.js';
import { ComputationScheduler } from '../compute/computation_scheduler.js';
import { AttachedDatabaseRegistry } from './session/connections/attached_database_registry.js';
import { ConnectionPersistenceProvider } from './session/connections/connection_persistence.js';
import { ComputeConnectionProvider } from '../compute/compute_connection_provider.js';
import { DashQLCoreProvider } from './providers/core_provider.js';
import { FileDownloaderProvider } from '../platform/file/file_downloader_provider.js';
import { FileDropzone } from './ui/file_dropzone.js';
import { FlavorProvider, FlavorUrlKeeper } from './flavor/flavor_provider.js';
import { applyFlavorToDocument, getAppFlavor } from './flavor/flavor_resolution.js';
import { GitHubTheme } from '../theme/github_theme.js';
import { HttpClientProvider } from '../platform/http/http_client_provider.js';
import { AIClientProvider } from '../platform/ai/ai_client_provider.js';
import { HyperConnector } from './session/connections/hyper/hyper_connector.js';
import { HyperDatabaseClientProvider } from './session/connections/hyper/hyperdb_grpc_client_provider.js';
import { HyperPlanDemoPage } from './ui/demos/plan_demo.js';
import { JsonViewerExperimentPage } from './ui/demos/json_demo.js';
import { LoggerToast } from '../ui/logger/logger_toast.js';
import { NavBarContainer } from './ui/navbar.js';
import { PlatformEventListenerProvider } from '../platform/events/event_listener_provider.js';
import { PlatformTypeProvider } from '../platform/platform_type.js';
import { ProcessProvider } from '../platform/process.js';
import { PromptDemoPage } from './ui/demos/prompt_demo.js';
import { QueryExecutorProvider } from './session/connections/query_executor.js';
import { RouterReset } from './router/router_reset.js';
import { SalesforceConnector } from './session/connections/salesforce/salesforce_connector.js';
import { StorageProvider } from './storage/storage_provider.js';
import { TrinoConnector } from './session/connections/trino/trino_connector.js';
import { ToolsPage } from './ui/tools/tools_page.js';
import { UIExperimentPage } from './ui/demos/ui_demo.js';
import { VersionCheck } from '../platform/version/version_check.js';
import { SessionCommands } from './session/scripts/session_commands.js';
import { SessionPage } from './session/ui/session_page.js';
import { SessionScriptsRegistryProvider } from './session/scripts/session_scripts_registry.js';
import { getGlobalLogger, LoggerProvider } from '../platform/logger/logger_provider.js';
import { stringifyError } from '../platform/logger/logger.js';
import { EmbeddedDatabaseProvider } from '../platform/database/embedded_database_provider.js';
import { isDebugBuild } from '../globals.js';
import { NativeSessionSync } from './session/persistence/native_session_sync_react.js';
import { SessionComputeQueryExecutionProvider } from './session/connections/computation_query_execution.js';
import { SessionImportProvider } from './session/persistence/session_import_provider.js';
import { SessionExecutionProvider } from './session/scripts/session_execution_provider.js';

import '../../static/fonts/fonts.css';
import '../styles/colors.css';
import '../styles/globals.css';
import '../styles/flavors/sidb.css';

const LOG_CTX = 'app';

const APP_FLAVOR = getAppFlavor();
applyFlavorToDocument(APP_FLAVOR);

// Note that the order among connection providers is important and non-obvious.
// For example:
// - CatalogLoaderProvider requires SessionScriptsRegistryProvider to mark connection scripts as outdated.
const SessionProviders = (props: { children: React.ReactElement }) => (
    <AttachedDatabaseRegistry>
        <ConnectionPersistenceProvider>
            <SalesforceConnector>
                <HyperConnector>
                    <TrinoConnector>
                        <ComputationRegistry>
                            <SessionComputeQueryExecutionProvider>
                                <ComputationScheduler />
                                <QueryExecutorProvider>
                                    <SessionScriptsRegistryProvider>
                                        <SessionExecutionProvider>
                                            <NativeSessionSync />
                                            <CatalogLoaderProvider>
                                                <SessionImportProvider>
                                                    <SessionCommands>
                                                        <AppLoader>
                                                            {props.children}
                                                        </AppLoader>
                                                    </SessionCommands>
                                                </SessionImportProvider>
                                            </CatalogLoaderProvider>
                                        </SessionExecutionProvider>
                                    </SessionScriptsRegistryProvider>
                                </QueryExecutorProvider>
                            </SessionComputeQueryExecutionProvider>
                        </ComputationRegistry>
                    </TrinoConnector>
                </HyperConnector>
            </SalesforceConnector>
        </ConnectionPersistenceProvider>
    </AttachedDatabaseRegistry>
);

const AppProviders = (props: { children: React.ReactElement }) => (
    <GitHubTheme>
        <PlatformTypeProvider>
            <LoggerProvider>
                <LoggerToast />
                <FileDownloaderProvider>
                    <AppConfigProvider>
                        <PlatformEventListenerProvider>
                            <ProcessProvider>
                                <VersionCheck>
                                    <StorageProvider>
                                        <HttpClientProvider>
                                            <AppSettingsSync>
                                                <AIClientProvider>
                                                    <HyperDatabaseClientProvider>
                                                        <DashQLCoreProvider initialSetup={{ setupBatchWorker: true }}>
                                                            <EmbeddedDatabaseProvider>
                                                                <ComputeConnectionProvider>
                                                                    <SessionProviders>
                                                                        {props.children}
                                                                    </SessionProviders>
                                                                </ComputeConnectionProvider>
                                                            </EmbeddedDatabaseProvider>
                                                        </DashQLCoreProvider>
                                                    </HyperDatabaseClientProvider>
                                                </AIClientProvider>
                                            </AppSettingsSync>
                                        </HttpClientProvider>
                                    </StorageProvider>
                                </VersionCheck>
                            </ProcessProvider>
                        </PlatformEventListenerProvider>
                    </AppConfigProvider>
                </FileDownloaderProvider>
            </LoggerProvider>
        </PlatformTypeProvider>
    </GitHubTheme>
);

const Router = process.env.DASHQL_RELATIVE_IMPORTS ? HashRouter : BrowserRouter;

const NavigateWithState = (props: { to: string }): React.ReactElement => {
    const location = useLocation();
    return <Navigate to={props.to} replace state={location.state} />;
};

function logRecoverableReactError(error: unknown, errorInfo: React.ErrorInfo) {
    // We're not part of the provider tree.
    // Access the logger globally.
    const logger = getGlobalLogger();
    // Do nothing if it's not existing yet
    if (logger == null) {
        return;
    }
    console.log(error);
    console.log(errorInfo.componentStack);
    logger.info("React encountered a recoverable error", {
        error: stringifyError(error),
        stack: errorInfo.componentStack,
    }, LOG_CTX);

}

const element = document.getElementById('root');
const root = createRoot(element!, {
    onRecoverableError: logRecoverableReactError
});
root.render(
    <FlavorProvider flavor={APP_FLAVOR}>
        <Router>
            <RouterReset />
            <FlavorUrlKeeper />
            <AppProviders>
                <FileDropzone>
                    <NavBarContainer>
                        <Routes>
                            <Route index Component={SessionPage} />
                            <Route path="/session" Component={SessionPage} />
                            <Route path="/sessions/:sessionId" Component={SessionPage} />
                            <Route path="/tool" element={<NavigateWithState to="/tool/format" />} />
                            <Route path="/tool/format" Component={ToolsPage} />
                            <Route path="/tool/hyperplan" Component={ToolsPage} />
                            <Route path="/tool/sparkplan" Component={ToolsPage} />
                            {isDebugBuild() && (
                                <>
                                    <Route path="/demo/ui" Component={UIExperimentPage} />
                                    <Route path="/demo/plan" Component={HyperPlanDemoPage} />
                                    <Route path="/demo/json" Component={JsonViewerExperimentPage} />
                                    <Route path="/demo/prompt" Component={PromptDemoPage} />
                                </>
                            )}
                            <Route path="*" element={<NavigateWithState to="/" />} />
                        </Routes>
                    </NavBarContainer>
                </FileDropzone>
            </AppProviders>
        </Router>
    </FlavorProvider>
);
