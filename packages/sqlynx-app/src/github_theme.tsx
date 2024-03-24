import * as React from "react";

import { ThemeProvider, BaseStyles } from '@primer/react';
import { StyleSheetManager } from 'styled-components';
import isPropValid from '@emotion/is-prop-valid';

import style from './github_theme.module.css';

export const GitHubTheme = (props: { children: React.ReactElement }) => (
    <StyleSheetManager shouldForwardProp={isPropValid}>
        <ThemeProvider dayScheme="light" nightScheme="light">
            <BaseStyles className={style.base_style}>
                {props.children}
            </BaseStyles>
        </ThemeProvider>
    </StyleSheetManager >
);
