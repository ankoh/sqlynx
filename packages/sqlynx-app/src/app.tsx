import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter, HashRouter } from 'react-router-dom';

import { AppConfigProvider } from './app_config.js';
import { AppEventListenerProvider } from './platform/event_listener_provider.js';
import { CatalogLoader } from './session/catalog_loader.js';
import { ConnectionRegistry } from './connectors/connection_registry.js';
import { ConnectorsPage, ConnectorsPageStateProvider } from './view/connectors/connectors_page.js';
import { CurrentSessionStateProvider } from './session/current_session.js';
import { EditorPage } from './view/editor/editor_page.js';
import { FilesPage } from './view/files/files_page.js';
import { UIInternalsPage } from './view/internals/ui_internals_page.js';
import { GitHubTheme } from './github_theme.js';
import { HttpClientProvider } from './platform/http_client_provider.js';
import { HyperDatabaseClientProvider } from './platform/hyperdb_client_provider.js';
import { HyperGrpcConnector } from './connectors/hyper_grpc_connector.js';
import { HyperGrpcConnectorSettingsStateProvider } from './view/connectors/hyper_grpc_connector_settings.js';
import { LoggerProvider } from './platform/logger_provider.js';
import { PlatformTypeProvider } from './platform/platform_type.js';
import { QueryExecutor } from './session/query_executor.js';
import { SQLynxLoader } from './sqlynx_loader.js';
import { SalesforceConnector } from './connectors/salesforce_connector.js';
import { SalesforceConnectorSettingsStateProvider } from './view/connectors/salesforce_connector_settings.js';
import { ScriptLoader } from './session/script_loader.js';
import { SessionCommands } from './session/session_commands.js';
import { SessionSetup } from './session/session_setup.js';
import { SessionStateRegistry } from './session/session_state_registry.js';
import { VersionCheck } from './platform/version_check.js';
import { withNavBar } from './view/navbar.js';

import './../static/fonts/fonts.css';
import './globals.css';

const SessionProviders = (props: { children: React.ReactElement }) => (
    <SessionStateRegistry>
        <CurrentSessionStateProvider>
            <ScriptLoader />
            <CatalogLoader />
            <QueryExecutor />
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
                {props.children}
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
                        <VersionCheck>
                            <HttpClientProvider>
                                <HyperDatabaseClientProvider>
                                    <SQLynxLoader>
                                        <Connectors>
                                            <SessionProviders>
                                                <PageStateProviders>
                                                    {props.children}
                                                </PageStateProviders>
                                            </SessionProviders>
                                        </Connectors>
                                    </SQLynxLoader>
                                </HyperDatabaseClientProvider>
                            </HttpClientProvider>
                        </VersionCheck>
                    </AppEventListenerProvider>
                </AppConfigProvider>
            </LoggerProvider>
        </PlatformTypeProvider>
    </GitHubTheme>
);

const EditorPageWithNav = withNavBar(EditorPage);
const ConnectorsPageWithNav = withNavBar(ConnectorsPage);
const FilesPageWithNav = withNavBar(FilesPage);
const UIInternalsPageWithNav = withNavBar(UIInternalsPage);

const Router = process.env.SQLYNX_RELATIVE_IMPORTS ? HashRouter : BrowserRouter;

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <Router>
        <AppProviders>
            <Routes>
                <Route index element={<EditorPageWithNav />} />
                <Route path="/connectors" element={<ConnectorsPageWithNav />} />
                <Route path="/files" element={<FilesPageWithNav />} />
                <Route path="/internals/ui" element={<UIInternalsPageWithNav />} />
                <Route path="*" element={<Navigate to="/" />} />
            </Routes>
        </AppProviders>
    </Router>
);
