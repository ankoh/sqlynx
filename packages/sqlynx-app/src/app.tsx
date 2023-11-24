import * as React from 'react';
import { SQLynxLoader } from './sqlynx_loader';
import { withNavBar } from './view/navbar';
import { EditorPage } from './view/pages/editor_page';
import { ConnectionsPage } from './view/pages/connections_page';
import { ScriptLoader } from './scripts/script_loader';
import { AppStateProvider } from './state/app_state_provider';
import { GitHubAuthProvider, GitHubProfileProvider } from './github';
import { LogProvider } from './state';
import { AppConfigResolver } from './state/app_config';

import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter } from 'react-router-dom';

import '../static/fonts/fonts.module.css';
import './globals.css';

const DataProviders = (props: { children: React.ReactElement }) => (
    <AppConfigResolver>
        <LogProvider>
            <GitHubAuthProvider>
                <GitHubProfileProvider>
                    <SQLynxLoader>
                        <AppStateProvider>
                            <ScriptLoader>{props.children}</ScriptLoader>
                        </AppStateProvider>
                    </SQLynxLoader>
                </GitHubProfileProvider>
            </GitHubAuthProvider>
        </LogProvider>
    </AppConfigResolver>
);

const Editor = withNavBar(EditorPage);
const Connections = withNavBar(ConnectionsPage);

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <React.StrictMode>
        <BrowserRouter>
            <DataProviders>
                <Routes>
                    <Route index element={<Editor />} />
                    <Route path="/connections" element={<Connections />} />
                    <Route path="*" element={<Navigate to="/" />} />
                </Routes>
            </DataProviders>
        </BrowserRouter>
    </React.StrictMode>,
);
