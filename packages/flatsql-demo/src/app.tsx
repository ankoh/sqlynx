import * as React from 'react';
import { BackendProvider } from './backend';
import { DemoPage } from './pages/demo';
import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter } from 'react-router-dom';

import '../static/fonts/fonts.module.css';
import './globals.css';

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <BrowserRouter>
        <BackendProvider>
            <Routes>
                <Route index element={<DemoPage />} />
                <Route path="*" element={<Navigate to="/" />} />
            </Routes>
        </BackendProvider>
    </BrowserRouter>
);