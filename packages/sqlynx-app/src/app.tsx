import * as React from 'react';

import { SQLynxLoader } from './sqlynx_loader.js';
import { withNavBar } from './view/navbar.js';
import { EditorPage } from './view/editor/editor_page.js';
import { ConnectorsPage } from './view/connectors/connectors_page.js';
import { ScriptLoader } from './session/script_loader.js';
import { CatalogLoader } from './session/catalog_loader.js';
import { ScriptAutoloaderSalesforce } from './session/script_autoloader_salesforce.js';
import { ScriptAutoloaderLocal } from './session/script_autoloader_local.js';
import { SessionStateProvider } from './session/session_state_provider.js';
import { SessionCommands } from './session/session_commands.js';
import { QueryExecutor } from './session/query_executor.js';
import { SessionURLSetup } from './session/session_url_setup.js';
import { SalesforceConnector } from './connectors/salesforce_connector.js';
import { LogProvider } from './app_log.js';
import { AppConfigResolver } from './app_config.js';
import { SQLYNX_GIT_COMMIT, SQLYNX_VERSION } from './app_version.js';
import { NativeApiProvider } from './native_api.js';

import { ThemeProvider } from '@primer/react';
import { StyleSheetManager } from 'styled-components';
import isPropValid from '@emotion/is-prop-valid';

import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter, HashRouter } from 'react-router-dom';

import './../static/fonts/fonts.css';
import './globals.css';

const GitHubDesignSystem = (props: { children: React.ReactElement }) => (
    <StyleSheetManager shouldForwardProp={isPropValid}>
        <ThemeProvider>{props.children}</ThemeProvider>
    </StyleSheetManager>
);

const AppProviders = (props: { children: React.ReactElement }) => (
    <GitHubDesignSystem>
        <LogProvider>
            <NativeApiProvider>
                <AppConfigResolver>
                    <SQLynxLoader>
                        <SalesforceConnector>
                            <SessionStateProvider>
                                <SessionCommands>
                                    <ScriptLoader />
                                    <ScriptAutoloaderLocal />
                                    <ScriptAutoloaderSalesforce />
                                    <CatalogLoader />
                                    <QueryExecutor />
                                    <SessionURLSetup>{props.children}</SessionURLSetup>
                                </SessionCommands>
                            </SessionStateProvider>
                        </SalesforceConnector>
                    </SQLynxLoader>
                </AppConfigResolver>
            </NativeApiProvider>
        </LogProvider>
    </GitHubDesignSystem>
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
