import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter, HashRouter } from 'react-router-dom';

import { AppConfigProvider } from './app_config.js';
import { AppEventListenerProvider } from './platform/event_listener_provider.js';
import { CatalogLoaderProvider } from './connection/catalog_loader.js';
import { ComputationRegistry } from './compute/computation_registry.js';
import { ConnectionRegistry } from './connection/connection_registry.js';
import { ConnectorsPage, ConnectorsPageStateProvider } from './view/connection/connection_page.js';
import { CurrentWorkbookStateProvider } from './workbook/current_workbook.js';
import { EditorPage } from './view/workbook/workbook_page.js';
import { GitHubTheme } from './github_theme.js';
import { HttpClientProvider } from './platform/http_client_provider.js';
import { HyperDatabaseClientProvider } from './connection/hyper/hyperdb_client_provider.js';
import { HyperGrpcConnector } from './connection/hyper/hyper_connector.js';
import { HyperGrpcConnectorSettingsStateProvider } from './view/connection/hyper_grpc_connector_settings.js';
import { LoggerProvider } from './platform/logger_provider.js';
import { NavBarContainer } from './view/navbar.js';
import { PlatformTypeProvider } from './platform/platform_type.js';
import { PlotInternalsPage } from './view/internals/plot_internals_page.js';
import { ProcessProvider } from './platform/process.js';
import { QueryExecutorProvider } from './connection/query_executor.js';
import { SQLynxComputeProvider } from './compute/compute_provider.js';
import { SQLynxCoreProvider } from './core_provider.js';
import { SalesforceConnector } from './connection/salesforce/salesforce_connector.js';
import { SalesforceConnectorSettingsStateProvider } from './view/connection/salesforce_connector_settings.js';
import { SchemaGraphDemoPage } from './view/internals/schema_graph_demo.js';
import { ScriptLoader } from './workbook/script_loader.js';
import { WorkbookCommands } from './workbook/workbook_commands.js';
import { WorkbookSetupGate } from './workbook/workbook_setup_gate.js';
import { WorkbookStateRegistry } from './workbook/workbook_state_registry.js';
import { TrinoConnector } from './connection/trino/trino_connector.js';
import { TrinoConnectorSettingsStateProvider } from './view/connection/trino_connector_settings.js';
import { UIInternalsPage } from './view/internals/ui_internals_page.js';
import { VersionCheck } from './platform/version_check.js';
import { isDebugBuild } from './globals.js';

import './../static/fonts/fonts.css';
import './colors.css';
import './globals.css';

// We decouple (some) page states from the actual page views to remember user input
const PageStateProviders = (props: { children: React.ReactElement }) => (
    <ConnectorsPageStateProvider>
        <SalesforceConnectorSettingsStateProvider>
            <HyperGrpcConnectorSettingsStateProvider>
                <TrinoConnectorSettingsStateProvider>
                    {props.children}
                </TrinoConnectorSettingsStateProvider>
            </HyperGrpcConnectorSettingsStateProvider>
        </SalesforceConnectorSettingsStateProvider>
    </ConnectorsPageStateProvider>
);

// Note that the order among connection providers is important and non-obvious.
// For example:
// - CatalogLoaderProvider requires the WorkbookStateRegistry to mark connection workbooks as outdated.
const WorkbookProviders = (props: { children: React.ReactElement }) => (
    <ConnectionRegistry>
        <SalesforceConnector>
            <HyperGrpcConnector>
                <TrinoConnector>
                    <ComputationRegistry>
                        <QueryExecutorProvider>
                            <WorkbookStateRegistry>
                                <CatalogLoaderProvider>
                                    <CurrentWorkbookStateProvider>
                                        <ScriptLoader />
                                        <WorkbookCommands>
                                            <WorkbookSetupGate>
                                                {props.children}
                                            </WorkbookSetupGate>
                                        </WorkbookCommands>
                                    </CurrentWorkbookStateProvider>
                                </CatalogLoaderProvider>
                            </WorkbookStateRegistry>
                        </QueryExecutorProvider>
                    </ComputationRegistry>
                </TrinoConnector>
            </HyperGrpcConnector>
        </SalesforceConnector>
    </ConnectionRegistry>
);

const AppProviders = (props: { children: React.ReactElement }) => (
    <GitHubTheme>
        <PlatformTypeProvider>
            <LoggerProvider>
                <AppConfigProvider>
                    <AppEventListenerProvider>
                        <ProcessProvider>
                            <VersionCheck>
                                <HttpClientProvider>
                                    <HyperDatabaseClientProvider>
                                        <SQLynxCoreProvider>
                                            <SQLynxComputeProvider>
                                                <WorkbookProviders>
                                                    <PageStateProviders>
                                                        {props.children}
                                                    </PageStateProviders>
                                                </WorkbookProviders>
                                            </SQLynxComputeProvider>
                                        </SQLynxCoreProvider>
                                    </HyperDatabaseClientProvider>
                                </HttpClientProvider>
                            </VersionCheck>
                        </ProcessProvider>
                    </AppEventListenerProvider>
                </AppConfigProvider>
            </LoggerProvider>
        </PlatformTypeProvider>
    </GitHubTheme>
);

const Router = process.env.SQLYNX_RELATIVE_IMPORTS ? HashRouter : BrowserRouter;

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <Router>
        <AppProviders>
            <NavBarContainer>
                <Routes>
                    <Route index Component={EditorPage} />
                    <Route path="/connection" Component={ConnectorsPage} />
                    {isDebugBuild() && (
                        <>
                            <Route path="/internals/ui" Component={UIInternalsPage} />
                            <Route path="/internals/plot" Component={PlotInternalsPage} />
                            <Route path="/internals/schema" Component={SchemaGraphDemoPage} />
                        </>
                    )}
                    <Route path="*" element={<Navigate to="/" />} />
                </Routes>
            </NavBarContainer>
        </AppProviders>
    </Router>
);
