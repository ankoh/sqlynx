import * as React from 'react';

import { SQLynxLoader } from './sqlynx_loader';
import { withNavBar } from './view/navbar';
import { EditorPage } from './view/pages/editor_page';
import { ConnectionsPage } from './view/pages/connections_page';
import { SetupPage } from './view/pages/setup_page';
import { ScriptLoader } from './scripts/script_loader';
import { ScriptCatalogLoader } from './scripts/script_catalog_loader';
import { ScriptCatalogSalesforceAutoloader } from './scripts/script_catalog_autoloader_salesforce';
import { ScriptStateProvider } from './scripts/script_state_provider';
import { ScriptCommands } from './scripts/script_commands';
import { ScriptQueryExecutor } from './scripts/script_query_executor';
import { SalesforceConnector } from './connectors/salesforce_connector';
import { ConnectorSelection } from './connectors/connector_selection';
import { LogProvider } from './app_log';
import { AppConfigResolver } from './app_config';
import { isElectron } from './utils/user_agent';

import { ThemeProvider } from '@primer/react';
import { StyleSheetManager } from 'styled-components';
import isPropValid from '@emotion/is-prop-valid';

import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter, HashRouter } from 'react-router-dom';

import '../static/fonts/fonts.module.css';
import './globals.css';

const GitHubDesignSystem = (props: { children: React.ReactElement }) => (
    <StyleSheetManager shouldForwardProp={isPropValid}>
        <ThemeProvider>{props.children}</ThemeProvider>
    </StyleSheetManager>
);

const AppProviders = (props: { children: React.ReactElement }) => (
    <GitHubDesignSystem>
        <LogProvider>
            <AppConfigResolver>
                <SQLynxLoader>
                    <SalesforceConnector>
                        <ConnectorSelection>
                            <ScriptStateProvider>
                                <ScriptCommands>
                                    <ScriptLoader />
                                    <ScriptCatalogLoader />
                                    <ScriptCatalogSalesforceAutoloader />
                                    <ScriptQueryExecutor />
                                    {props.children}
                                </ScriptCommands>
                            </ScriptStateProvider>
                        </ConnectorSelection>
                    </SalesforceConnector>
                </SQLynxLoader>
            </AppConfigResolver>
        </LogProvider>
    </GitHubDesignSystem>
);

const Editor = withNavBar(EditorPage);
const Connections = withNavBar(ConnectionsPage);

const Router = isElectron() ? HashRouter : BrowserRouter;

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <React.StrictMode>
        <Router>
            <AppProviders>
                <Routes>
                    <Route index element={<Editor />} />
                    <Route path="/connections" element={<Connections />} />
                    <Route path="/setup" element={<SetupPage />} />
                    <Route path="*" element={<Navigate to="/" />} />
                </Routes>
            </AppProviders>
        </Router>
    </React.StrictMode>,
);
