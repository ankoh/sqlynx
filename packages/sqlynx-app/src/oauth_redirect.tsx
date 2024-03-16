import * as React from 'react';

import { AppConfigResolver } from './app_config.js';
import { SQLYNX_GIT_COMMIT, SQLYNX_VERSION } from './app_version.js';

import { ThemeProvider, BaseStyles } from '@primer/react';
import { StyleSheetManager } from 'styled-components';
import isPropValid from '@emotion/is-prop-valid';

import { createRoot } from 'react-dom/client';

import './../static/fonts/fonts.css';
import './globals.css';
import style from './app.module.css';

const GitHubDesignSystem = (props: { children: React.ReactElement }) => (
    <StyleSheetManager shouldForwardProp={isPropValid}>
        <ThemeProvider dayScheme="light" nightScheme="light">
            <BaseStyles className={style.base_style}>
                {props.children}
            </BaseStyles>
        </ThemeProvider>
    </StyleSheetManager>
);

console.log(SQLYNX_VERSION);
console.log(SQLYNX_GIT_COMMIT);

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <React.StrictMode>
        <GitHubDesignSystem>
            <AppConfigResolver>
                <div>Hello World</div>
            </AppConfigResolver>
        </GitHubDesignSystem>
    </React.StrictMode>,
);
