import * as React from 'react';
import { BackendProvider } from './backend';
import { EditorPage } from './pages/editor_page';
import { ScriptRegistryProvider } from './model/script_registry';
import { ScriptLoaderProvider } from './model/script_loader';
import { EditorContextProvider } from './editor/editor_context';
import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter } from 'react-router-dom';

import '../static/fonts/fonts.module.css';
import './globals.css';

const DataProviders = (props: { children: React.ReactElement }) => (
    <BackendProvider>
        <ScriptRegistryProvider>
            <ScriptLoaderProvider>
                <EditorContextProvider>{props.children}</EditorContextProvider>
            </ScriptLoaderProvider>
        </ScriptRegistryProvider>
    </BackendProvider>
);

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <BrowserRouter>
        <DataProviders>
            <Routes>
                <Route index element={<EditorPage />} />
                <Route path="*" element={<Navigate to="/" />} />
            </Routes>
        </DataProviders>
    </BrowserRouter>,
);
