import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter, HashRouter, useLocation } from 'react-router-dom';

import { AppConfigProvider } from './config/app_config.js';
import { AppLoader } from './loading/app_loader.js';
import { AppSettingsSync } from './config/app_settings_sync.js';
import { CatalogLoaderProvider } from './notebook/connections/catalog_loader.js';
import { ComputationRegistry } from '../compute/computation_registry.js';
import { ComputationScheduler } from '../compute/computation_scheduler.js';
import { AttachedDatabaseRegistry } from './notebook/connections/attached_database_registry.js';
import { ComputeConnectionProvider } from '../compute/compute_connection_provider.js';
import { DashQLCoreProvider } from './providers/core_provider.js';
import { FileDownloaderProvider } from '../platform/file/file_downloader_provider.js';
import { FileDropzone } from './ui/file_dropzone.js';
import { GitHubTheme } from '../theme/github_theme.js';
import { HttpClientProvider } from '../platform/http/http_client_provider.js';
import { HyperConnector } from './notebook/connections/hyper/hyper_connector.js';
import { HyperDatabaseClientProvider } from './notebook/connections/hyper/hyperdb_grpc_client_provider.js';
import { HyperPlanDemoPage } from './ui/demos/plan_demo.js';
import { JsonViewerExperimentPage } from './ui/demos/json_demo.js';
import { LoggerToast } from '../ui/logger/logger_toast.js';
import { NavBarContainer } from './ui/navbar.js';
import { PlatformEventListenerProvider } from '../platform/events/event_listener_provider.js';
import { PlatformTypeProvider } from '../platform/platform_type.js';
import { ProcessProvider } from '../platform/process.js';
import { PromptDemoPage } from './ui/demos/prompt_demo.js';
import { QueryExecutorProvider } from './notebook/connections/query_executor.js';
import { RouterReset } from './router/router_reset.js';
import { SalesforceConnector } from './notebook/connections/salesforce/salesforce_connector.js';
import { StorageProvider } from './notebook/persistence/storage_provider.js';
import { TrinoConnector } from './notebook/connections/trino/trino_connector.js';
import { ToolsPage } from './ui/tools/tools_page.js';
import { UIExperimentPage } from './ui/demos/ui_demo.js';
import { VersionCheck } from '../platform/version/version_check.js';
import { NotebookCommands } from './notebook/scripts/notebook_commands.js';
import { NotebookPage } from './notebook/ui/notebook_page.js';
import { NotebookScriptsRegistryProvider } from './notebook/scripts/notebook_scripts_registry.js';
import { getGlobalLogger, LoggerProvider } from '../platform/logger/logger_provider.js';
import { stringifyError } from '../platform/logger/logger.js';
import { EmbeddedDatabaseProvider } from '../platform/database/embedded_database_provider.js';
import { isDebugBuild } from '../globals.js';
import { NativeNotebookSync } from './notebook/persistence/native_notebook_sync_react.js';
import { NotebookComputeQueryExecutionProvider } from './notebook/connections/computation_query_execution.js';
import { NotebookImportProvider } from './notebook/persistence/notebook_import_provider.js';
import { NotebookExecutionProvider } from './notebook/scripts/notebook_execution_provider.js';

import '../../static/fonts/fonts.css';
import '../styles/colors.css';
import '../styles/globals.css';

const LOG_CTX = 'app';

// Note that the order among connection providers is important and non-obvious.
// For example:
// - CatalogLoaderProvider requires NotebookScriptsRegistryProvider to mark connection scripts as outdated.
const NotebookProviders = (props: { children: React.ReactElement }) => (
    <AttachedDatabaseRegistry>
        <SalesforceConnector>
            <HyperConnector>
                <TrinoConnector>
                    <ComputationRegistry>
                        <NotebookComputeQueryExecutionProvider>
                            <ComputationScheduler />
                            <QueryExecutorProvider>
                                <NotebookScriptsRegistryProvider>
                                    <NotebookExecutionProvider>
                                        <NativeNotebookSync />
                                        <CatalogLoaderProvider>
                                            <NotebookImportProvider>
                                                <NotebookCommands>
                                                    <AppLoader>
                                                        {props.children}
                                                    </AppLoader>
                                                </NotebookCommands>
                                            </NotebookImportProvider>
                                        </CatalogLoaderProvider>
                                    </NotebookExecutionProvider>
                                </NotebookScriptsRegistryProvider>
                            </QueryExecutorProvider>
                        </NotebookComputeQueryExecutionProvider>
                    </ComputationRegistry>
                </TrinoConnector>
            </HyperConnector>
        </SalesforceConnector>
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
                                                <HyperDatabaseClientProvider>
                                                    <DashQLCoreProvider initialSetup={{ setupBatchWorker: true }}>
                                                        <EmbeddedDatabaseProvider>
                                                            <ComputeConnectionProvider>
                                                                <NotebookProviders>
                                                                    {props.children}
                                                                </NotebookProviders>
                                                            </ComputeConnectionProvider>
                                                        </EmbeddedDatabaseProvider>
                                                    </DashQLCoreProvider>
                                                </HyperDatabaseClientProvider>
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
    <Router>
        <RouterReset />
        <AppProviders>
            <FileDropzone>
                <NavBarContainer>
                    <Routes>
                        <Route index Component={NotebookPage} />
                        <Route path="/notebook" Component={NotebookPage} />
                        <Route path="/notebooks/:notebookId" Component={NotebookPage} />
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
);
