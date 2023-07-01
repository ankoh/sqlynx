import * as React from 'react';
import { BackendProvider } from './backend';
import { CanvasPage } from './pages/canvas_page';
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
                <Route index element={<CanvasPage />} />
                <Route path="*" element={<Navigate to="/" />} />
            </Routes>
        </BackendProvider>
    </BrowserRouter>,
);
