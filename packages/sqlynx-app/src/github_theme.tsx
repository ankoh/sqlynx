import * as React from "react";

import { ThemeProvider, BaseStyles } from '@primer/react';
import { StyleSheetManager } from 'styled-components';
import isPropValid from '@emotion/is-prop-valid';

import * as style from './github_theme.module.css';

import '@primer/react-brand/lib/css/main.css'

export function GitHubTheme(props: { children: React.ReactElement }) {
    return (
        <StyleSheetManager shouldForwardProp={isPropValid}>
             <BaseStyles className={style.base_style}>
                 <ThemeProvider dayScheme="light" nightScheme="light">
                     {props.children}
                 </ThemeProvider>
             </BaseStyles>
        </StyleSheetManager>
    );
}
