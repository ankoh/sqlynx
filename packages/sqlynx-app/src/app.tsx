import * as React from 'react';

import { SQLynxLoader } from './sqlynx_loader';
import { withNavBar } from './view/navbar';
import { EditorPage } from './view/pages/editor_page';
import { SettingsPage } from './view/pages/settings_page';
import { ScriptLoader } from './scripts/script_loader';
import { ScriptCatalogLoader } from './scripts/script_catalog_loader';
import { ScriptAutoloaderSalesforce } from './scripts/script_autoloader_salesforce';
import { ScriptAutoloaderLocal } from './scripts/script_autoloader_local';
import { ScriptStateProvider } from './scripts/script_state_provider';
import { ScriptCommands } from './scripts/script_commands';
import { ScriptQueryExecutor } from './scripts/script_query_executor';
import { ScriptURLSetup } from './scripts/script_url_setup';
import { SalesforceConnector } from './connectors/salesforce_connector';
import { LogProvider } from './app_log';
import { AppConfigResolver } from './app_config';
import { ElectronContextResolver, isElectron } from './electron_context';

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
            <ElectronContextResolver>
                <AppConfigResolver>
                    <SQLynxLoader>
                        <SalesforceConnector>
                            <ScriptStateProvider>
                                <ScriptCommands>
                                    <ScriptLoader />
                                    <ScriptCatalogLoader />
                                    <ScriptAutoloaderSalesforce />
                                    <ScriptAutoloaderLocal />
                                    <ScriptQueryExecutor />
                                    <ScriptURLSetup>{props.children}</ScriptURLSetup>
                                </ScriptCommands>
                            </ScriptStateProvider>
                        </SalesforceConnector>
                    </SQLynxLoader>
                </AppConfigResolver>
            </ElectronContextResolver>
        </LogProvider>
    </GitHubDesignSystem>
);

const Editor = withNavBar(EditorPage);
const Settings = withNavBar(SettingsPage);

const Router = isElectron() ? HashRouter : BrowserRouter;

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <React.StrictMode>
        <Router>
            <AppProviders>
                <Routes>
                    <Route index element={<Editor />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="*" element={<Navigate to="/" />} />
                </Routes>
            </AppProviders>
        </Router>
    </React.StrictMode>,
);
