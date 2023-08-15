import * as React from 'react';
import { FlatSQLLoader } from './flatsql_loader';
import { EditorPage } from './pages/editor_page';
import { ScriptLoader } from './script_loader/script_loader';
import { AppStateProvider } from './state/app_state_provider';
import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter } from 'react-router-dom';

import '../static/fonts/fonts.module.css';
import './globals.css';

const DataProviders = (props: { children: React.ReactElement }) => (
    <FlatSQLLoader>
        <AppStateProvider>
            <ScriptLoader>{props.children}</ScriptLoader>
        </AppStateProvider>
    </FlatSQLLoader>
);

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <React.StrictMode>
        <BrowserRouter>
            <DataProviders>
                <Routes>
                    <Route index element={<EditorPage />} />
                    <Route path="*" element={<Navigate to="/" />} />
                </Routes>
            </DataProviders>
        </BrowserRouter>
    </React.StrictMode>,
);
