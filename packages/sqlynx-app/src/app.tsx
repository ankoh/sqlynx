import * as React from 'react';

import { SQLynxLoader } from './sqlynx_loader.js';
import { withNavBar } from './view/navbar.js';
import { EditorPage } from './view/editor/editor_page.js';
import { ConnectorsPage } from './view/connectors/connectors_page.js';
import { ScriptLoader } from './session/script_loader.js';
import { CatalogLoader } from './session/catalog_loader.js';
import { CurrentSessionStateProvider } from './session/current_session.js';
import { SessionStateRegistry } from './session/session_state_registry.js';
import { SessionCommands } from './session/session_commands.js';
import { QueryExecutor } from './session/query_executor.js';
import { SessionSetup } from './session/session_setup.js';
import { SalesforceConnector } from './connectors/salesforce_connector.js';
import { ConnectionRegistry } from './connectors/connection_registry.js';
import { GitHubTheme } from './github_theme.js';
import { AppConfigProvider } from './app_config.js';
import { LoggerProvider } from './platform/logger_provider.js';
import { PlatformTypeProvider } from './platform/platform_type.js';
import { HyperDatabaseClientProvider } from './platform/hyperdb_client_provider.js';
import { VersionCheck } from './platform/version_check.js';
import { AppEventListenerProvider } from './platform/event_listener_provider.js';
import { InitialSessionSetup } from './session/initial_session_setup.js';

import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter, HashRouter } from 'react-router-dom';

import './../static/fonts/fonts.css';
import './globals.css';

const AppProviders = (props: { children: React.ReactElement }) => (
    <GitHubTheme>
        <PlatformTypeProvider>
            <LoggerProvider>
                <AppConfigProvider>
                    <AppEventListenerProvider>
                        <VersionCheck>
                            <ConnectionRegistry>
                                <HyperDatabaseClientProvider>
                                    <SQLynxLoader>
                                        <SalesforceConnector>
                                            <SessionStateRegistry>
                                                <CurrentSessionStateProvider>
                                                    <InitialSessionSetup />
                                                    <SessionCommands>
                                                        <ScriptLoader />
                                                        <CatalogLoader />
                                                        <QueryExecutor />
                                                        <SessionSetup>{props.children}</SessionSetup>
                                                    </SessionCommands>
                                                </CurrentSessionStateProvider>
                                            </SessionStateRegistry>
                                        </SalesforceConnector>
                                    </SQLynxLoader>
                                </HyperDatabaseClientProvider>
                            </ConnectionRegistry>
                        </VersionCheck>
                    </AppEventListenerProvider>
                </AppConfigProvider>
            </LoggerProvider>
        </PlatformTypeProvider>
    </GitHubTheme>
);

const Editor = withNavBar(EditorPage);
const Connectors = withNavBar(ConnectorsPage);

const Router = process.env.SQLYNX_RELATIVE_IMPORTS ? HashRouter : BrowserRouter;

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <Router>
        <AppProviders>
            <Routes>
                <Route index element={<Editor />} />
                <Route path="/connectors" element={<Connectors />} />
                <Route path="*" element={<Navigate to="/" />} />
            </Routes>
        </AppProviders>
    </Router>
);
