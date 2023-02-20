import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Route, Routes, Navigate, BrowserRouter } from 'react-router-dom';

import '../static/fonts/fonts.module.css';
import './globals.css';

const Page = () => (<div>Hello World</div>);

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <BrowserRouter>
        <Routes>
            <Route
                index
                element={
                    <Page />
                }
            />
            <Route path="*" element={<Navigate to="/" />} />
        </Routes>
    </BrowserRouter>
);