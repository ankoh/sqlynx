import * as React from 'react';

import * as proto from '@ankoh/sqlynx-pb';

import { ThemeProvider, BaseStyles } from '@primer/react';
import { StyleSheetManager } from 'styled-components';
import isPropValid from '@emotion/is-prop-valid';
import { createRoot } from 'react-dom/client';
import { Route, Routes, BrowserRouter, useSearchParams } from 'react-router-dom';

import { BASE64_CODEC } from './utils/base64.js';

import './../static/fonts/fonts.css';
import './globals.css';
import style from './app.module.css';
import { OAuthFlowVariant, SalesforceOAuthOptions } from '@ankoh/sqlynx-pb/gen/sqlynx/oauth_pb.js';

const GitHubDesignSystem = (props: { children: React.ReactElement }) => (
    <StyleSheetManager shouldForwardProp={isPropValid}>
        <ThemeProvider dayScheme="light" nightScheme="light">
            <BaseStyles className={style.base_style}>
                {props.children}
            </BaseStyles>
        </ThemeProvider>
    </StyleSheetManager>
);

interface Props {

}

const RedirectPage: React.FC<Props> = (_props: Props) => {
    const [params, _setParams] = useSearchParams();
    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    console.log([code, state]);

    const authStateBuffer = BASE64_CODEC.decode(state);
    const authState = proto.sqlynx_oauth.pb.OAuthState.fromBinary(new Uint8Array(authStateBuffer));

    let flowVariant = "";
    switch (authState.flowVariant) {
        case OAuthFlowVariant.UNSPECIFIED_FLOW:
            flowVariant = "Unspecified";
            break;
        case OAuthFlowVariant.WEB_OPENER_FLOW:
            flowVariant = "Web App";
            break;
        case OAuthFlowVariant.NATIVE_LINK_FLOW:
            flowVariant = "Native App";
            break;
    }
    switch (authState.providerOptions.case) {
        case "salesforceProvider": {
            return (
                <div>
                    <div>{flowVariant}</div>
                    <div>{authState.providerOptions.value.instanceUrl}</div>
                    <div>{authState.providerOptions.value.appConsumerKey}</div>
                </div>
            );
        }
    }

    console.log(authState);
};

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <React.StrictMode>
        <BrowserRouter>
            <GitHubDesignSystem>
                <Routes>
                    <Route path="*" element={<RedirectPage />} />
                </Routes>
            </GitHubDesignSystem>
        </BrowserRouter>
    </React.StrictMode>,
);