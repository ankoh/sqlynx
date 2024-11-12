import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter, HashRouter } from 'react-router-dom';

import { AppConfigProvider } from './app_config.js';
import { AppEventListenerProvider } from './platform/event_listener_provider.js';
import { CatalogUpdaterProvider } from './connectors/catalog_loader.js';
import { ComputationRegistry } from './compute/computation_registry.js';
import { ConnectionRegistry } from './connectors/connection_registry.js';
import { ConnectorsPage, ConnectorsPageStateProvider } from './view/connectors/connectors_page.js';
import { CurrentSessionStateProvider } from './session/current_session.js';
import { EditorPage } from './view/editor/editor_page.js';
import { FilesPage } from './view/files/files_page.js';
import { GitHubTheme } from './github_theme.js';
import { HttpClientProvider } from './platform/http_client_provider.js';
import { HyperDatabaseClientProvider } from './platform/hyperdb_client_provider.js';
import { HyperGrpcConnector } from './connectors/hyper/hyper_connector.js';
import { HyperGrpcConnectorSettingsStateProvider } from './view/connectors/hyper_grpc_connector_settings.js';
import { LoggerProvider } from './platform/logger_provider.js';
import { NavBarContainer } from './view/navbar.js';
import { PlatformTypeProvider } from './platform/platform_type.js';
import { PlotInternalsPage } from './view/internals/plot_internals_page.js';
import { ProcessProvider } from './platform/process.js';
import { QueryExecutorProvider } from './connectors/query_executor.js';
import { SQLynxComputeProvider } from './compute/compute_provider.js';
import { SQLynxCoreProvider } from './core_provider.js';
import { SalesforceConnector } from './connectors/salesforce/salesforce_connector.js';
import { SalesforceConnectorSettingsStateProvider } from './view/connectors/salesforce_connector_settings.js';
import { SchemaGraphDemoPage } from './view/internals/schema_graph_demo.js';
import { ScriptLoader } from './session/script_loader.js';
import { SessionCommands } from './session/session_commands.js';
import { SessionSetup } from './session/session_setup.js';
import { SessionStateRegistry } from './session/session_state_registry.js';
import { ShellPage } from './view/shell/shell_page.js';
import { UIInternalsPage } from './view/internals/ui_internals_page.js';
import { VersionCheck } from './platform/version_check.js';
import { isDebugBuild } from './globals.js';

import './../static/fonts/fonts.css';
import './colors.css';
import './globals.css';

const SessionProviders = (props: { children: React.ReactElement }) => (
    <SessionStateRegistry>
        <CurrentSessionStateProvider>
            <ScriptLoader />
            <SessionCommands>
                <SessionSetup>
                    {props.children}
                </SessionSetup>
            </SessionCommands>
        </CurrentSessionStateProvider>
    </SessionStateRegistry>
);

const PageStateProviders = (props: { children: React.ReactElement }) => (
    <ConnectorsPageStateProvider>
        <SalesforceConnectorSettingsStateProvider>
            <HyperGrpcConnectorSettingsStateProvider>
                {props.children}
            </HyperGrpcConnectorSettingsStateProvider>
        </SalesforceConnectorSettingsStateProvider>
    </ConnectorsPageStateProvider>
);

const Connectors = (props: { children: React.ReactElement }) => (
    <ConnectionRegistry>
        <SalesforceConnector>
            <HyperGrpcConnector>
                <CatalogUpdaterProvider>
                    <Compute>
                        <QueryExecutorProvider>
                            {props.children}
                        </QueryExecutorProvider>
                    </Compute>
                </CatalogUpdaterProvider>
            </HyperGrpcConnector>
        </SalesforceConnector>
    </ConnectionRegistry>
);

const Compute = (props: { children: React.ReactElement }) => (
    <ComputationRegistry>
        {props.children}
    </ComputationRegistry>
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
                                                <Connectors>
                                                    <SessionProviders>
                                                        <PageStateProviders>
                                                            {props.children}
                                                        </PageStateProviders>
                                                    </SessionProviders>
                                                </Connectors>
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
                    <Route path="/connectors" Component={ConnectorsPage} />
                    <Route path="/files" Component={FilesPage} />
                    <Route path="/shell" Component={ShellPage} />
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
