import * as React from 'react';

import { SQLynxLoader } from './sqlynx_loader.js';
import { withNavBar } from './view/navbar.js';
import { EditorPage } from './view/editor/editor_page.js';
import { ConnectorsPage } from './view/connectors/connectors_page.js';
import { ScriptLoader } from './session/script_loader.js';
import { CatalogLoader } from './session/catalog_loader.js';
import { ScriptAutoloaderBrainstorm } from './session/script_autoloader_brainstorm.js';
import { ScriptAutoloaderSalesforce } from './session/script_autoloader_salesforce.js';
import { SessionStateProvider } from './session/session_state_provider.js';
import { SessionCommands } from './session/session_commands.js';
import { QueryExecutor } from './session/query_executor.js';
import { SessionLinkManager } from './session/session_link_manager.js';
import { SalesforceConnector } from './connectors/salesforce_connector.js';
import { GitHubTheme } from './github_theme.js';
import { AppConfigResolver } from './app_config.js';
import { SQLYNX_GIT_COMMIT, SQLYNX_VERSION } from './app_version.js';
import { LoggerProvider } from './platform/logger_provider.js';
import { PlatformTypeProvider } from './platform/platform_type.js';
import { HyperDatabaseClientProvider } from './platform/hyperdb_client_provider.js';

import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter, HashRouter } from 'react-router-dom';

import './../static/fonts/fonts.css';
import './globals.css';

const AppProviders = (props: { children: React.ReactElement }) => (
    <GitHubTheme>
        <PlatformTypeProvider>
            <LoggerProvider>
                <AppConfigResolver>
                    <HyperDatabaseClientProvider>
                        <SQLynxLoader>
                            <SalesforceConnector>
                                <SessionStateProvider>
                                    <SessionCommands>
                                        <ScriptLoader />
                                        <ScriptAutoloaderBrainstorm />
                                        <ScriptAutoloaderSalesforce />
                                        <CatalogLoader />
                                        <QueryExecutor />
                                        <SessionLinkManager>{props.children}</SessionLinkManager>
                                    </SessionCommands>
                                </SessionStateProvider>
                            </SalesforceConnector>
                        </SQLynxLoader>
                    </HyperDatabaseClientProvider>
                </AppConfigResolver>
            </LoggerProvider>
        </PlatformTypeProvider>
    </GitHubTheme>
);

const Editor = withNavBar(EditorPage);
const Connectors = withNavBar(ConnectorsPage);

const Router = process.env.SQLYNX_RELATIVE_IMPORTS ? HashRouter : BrowserRouter;

console.log(SQLYNX_VERSION);
console.log(SQLYNX_GIT_COMMIT);

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <React.StrictMode>
        <Router>
            <AppProviders>
                <Routes>
                    <Route index element={<Editor />} />
                    <Route path="/connectors" element={<Connectors />} />
                    <Route path="*" element={<Navigate to="/" />} />
                </Routes>
            </AppProviders>
        </Router>
    </React.StrictMode>,
);
