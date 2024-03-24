import * as React from 'react';

import * as proto from '@ankoh/sqlynx-pb';

import { Button } from '@primer/react';
import { createRoot } from 'react-dom/client';
import { Route, Routes, BrowserRouter, useSearchParams } from 'react-router-dom';

import { BASE64_CODEC } from './utils/base64.js';
import { RESULT_OK, RESULT_ERROR, Result } from './utils/result.js';
import { SQLYNX_VERSION } from './app_version.js';
import { TextField } from './view/text_field.js';
import { GitHubTheme } from './github_theme.js';

import _styles from './oauth_redirect.module.css';
import page_styles from './view/banner_page.module.css';
import * as symbols from '../static/svg/symbols.generated.svg';

import '../static/fonts/fonts.css';
import './globals.css';

interface OAuthSucceededProps {
    state: proto.sqlynx_oauth.pb.OAuthState;
}

const OAuthSucceeded: React.FC<OAuthSucceededProps> = (props: OAuthSucceededProps) => {
    // Render provider arguments from state
    let infoSection: React.ReactElement = <div />;
    switch (props.state.providerOptions.case) {
        case "salesforceProvider": {
            infoSection = (
                <div className={page_styles.card_section}>
                    <div className={page_styles.section_entries}>
                        <TextField
                            name="Salesforce Instance URL"
                            value={"foo"}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>URL</div>}
                        />
                        <TextField
                            name="Connected App"
                            value={"foo"}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>ID</div>}
                        />
                    </div>
                </div>
            );
        }
    }
    // Construct the page
    return (
        <div className={page_styles.page}>
            <div className={page_styles.banner_container}>
                <div className={page_styles.banner_logo}>
                    <svg width="100%" height="100%">
                        <use xlinkHref={`${symbols}#sqlynx-inverted`} />
                    </svg>
                </div>
                <div className={page_styles.banner_text_container}>
                    <div className={page_styles.banner_title}>sqlynx</div>
                    <div className={page_styles.app_version}>version {SQLYNX_VERSION}</div>
                </div>
            </div>
            <div className={page_styles.card_container}>
                <div className={page_styles.card_header}>
                    <div>Authorization Succeeded</div>
                </div>
                {infoSection}
                <div className={page_styles.card_section}>
                    <div className={page_styles.section_entries}>
                        <TextField
                            name="Authorization Code"
                            value={"*****"}
                            onChange={() => { }}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>Code</div>}
                        />
                    </div>
                </div>
                <div className={page_styles.card_actions}>
                    <Button className={page_styles.card_action_continue} variant="primary">
                        Continue
                    </Button>
                </div>
            </div>
        </div>
    );
}

interface OAuthFailedProps {
    error: Error;
}

const OAuthFailed: React.FC<OAuthFailedProps> = (props: OAuthFailedProps) => {
    return (
        <div className={page_styles.page}>
            <div className={page_styles.banner_container}>
                <div className={page_styles.banner_logo}>
                    <svg width="100%" height="100%">
                        <use xlinkHref={`${symbols}#sqlynx-inverted`} />
                    </svg>
                </div>
                <div className={page_styles.banner_text_container}>
                    <div className={page_styles.banner_title}>sqlynx</div>
                    <div className={page_styles.app_version}>version {SQLYNX_VERSION}</div>
                </div>
            </div>
            <div className={page_styles.card_container}>
                <div className={page_styles.card_header}>
                    <div>Authorization Failed</div>
                </div>
                {props.error.toString()}
            </div>
        </div>
    );
}


interface RedirectPageProps { }


const RedirectPage: React.FC<RedirectPageProps> = (_props: RedirectPageProps) => {
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

    if (authState.type == RESULT_OK) {
        return <OAuthSucceeded state={authState.value} />
    } else {
        return <OAuthFailed error={authState.error} />
    }
};

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <React.StrictMode>
        <BrowserRouter>
            <GitHubTheme>
                <Routes>
                    <Route path="*" element={<RedirectPage />} />
                </Routes>
            </GitHubTheme>
        </BrowserRouter>
    </React.StrictMode>,
);
