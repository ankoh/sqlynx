import * as React from 'react';

import * as proto from '@ankoh/sqlynx-pb';

import isPropValid from '@emotion/is-prop-valid';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { StyleSheetManager } from 'styled-components';
import { createRoot } from 'react-dom/client';
import { Route, Routes, BrowserRouter, useSearchParams } from 'react-router-dom';

import { BASE64_CODEC } from './utils/base64.js';
import { RESULT_OK, RESULT_ERROR, Result } from './utils/result.js';

import './../static/fonts/fonts.css';
import './globals.css';

import style from './oauth_redirect.module.css';

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

    const authState = React.useMemo<Result<proto.sqlynx_oauth.pb.OAuthState>>(() => {
        try {
            const authStateBuffer = BASE64_CODEC.decode(state);
            return {
                type: RESULT_OK,
                value: proto.sqlynx_oauth.pb.OAuthState.fromBinary(new Uint8Array(authStateBuffer))
            };
        } catch (e: any) {
            return {
                type: RESULT_ERROR,
                error: new Error(e.toString()),
            };
        }
    }, [state]);

    console.log(authState);

    if (authState.type == RESULT_ERROR) {
        return (
            <div>
                <div>Received malformed OAuth state</div>
                <div>{authState.error.message}</div>
            </div>
        );
    } else {
        let flowVariant = "";
        switch (authState.value.flowVariant) {
            case proto.sqlynx_oauth.pb.OAuthFlowVariant.UNSPECIFIED_FLOW:
                flowVariant = "Unspecified";
                break;
            case proto.sqlynx_oauth.pb.OAuthFlowVariant.WEB_OPENER_FLOW:
                flowVariant = "Web App";
                break;
            case proto.sqlynx_oauth.pb.OAuthFlowVariant.NATIVE_LINK_FLOW:
                flowVariant = "Native App";
                break;
        }
        switch (authState.value.providerOptions.case) {
            case "salesforceProvider": {
                return (
                    <div>
                        <div>{flowVariant}</div>
                        <div>{authState.value.providerOptions.value.instanceUrl}</div>
                        <div>{authState.value.providerOptions.value.appConsumerKey}</div>
                    </div>
                );
            }
        }
    }
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
