import * as React from 'react';

import * as proto from '@ankoh/sqlynx-pb';

import { Button, IconButton } from '@primer/react';
import { createRoot } from 'react-dom/client';
import { Route, Routes, BrowserRouter, useSearchParams } from 'react-router-dom';

import { BASE64_CODEC } from './utils/base64.js';
import { RESULT_OK, RESULT_ERROR, Result } from './utils/result.js';
import { SQLYNX_VERSION } from './globals.js';
import { TextField, TextFieldValidationStatus, VALIDATION_ERROR, VALIDATION_WARNING } from './view/text_field.js';
import { GitHubTheme } from './github_theme.js';
import { formatHHMMSS, formatTimeDifference } from './utils/format.js';
import { LogViewerInPortal } from './view/log_viewer.js';
import { LoggerProvider, useLogger } from './platform/logger_provider.js';
import { Logger } from './platform/logger.js';

import _styles from './oauth_redirect.module.css';
import page_styles from './view/banner_page.module.css';
import * as symbols from '../static/svg/symbols.generated.svg';

import '../static/fonts/fonts.css';
import './globals.css';

const AUTOTRIGGER_DELAY = 2000;

interface OAuthSucceededProps {
    params: URLSearchParams;
    state: proto.sqlynx_oauth.pb.OAuthState;
}

function triggerFlow(state: proto.sqlynx_oauth.pb.OAuthState, code: string, logger: Logger) {
    switch (state.flowVariant) {
        case proto.sqlynx_oauth.pb.OAuthFlowVariant.NATIVE_LINK_FLOW: {
            const data = new proto.sqlynx_oauth.pb.OAuthRedirectData({ code, state });
            const dataBase64 = BASE64_CODEC.encode(data.toBinary().buffer);
            const deepLink = new URL(`sqlynx://localhost/oauth?data=${dataBase64}`);
            logger.info(`opening deep link`, "oauth_redirect");
            window.open(deepLink, '_self');
            break;
        }
        case proto.sqlynx_oauth.pb.OAuthFlowVariant.WEB_OPENER_FLOW: {
            if (!window.opener) {
                logger.error("window opener is undefined", "oauth_redirect");
                return;
            }
            const eventMessage = new proto.sqlynx_app_event.pb.AppEvent({
                eventData: {
                    case: "oauthRedirect",
                    value: new proto.sqlynx_oauth.pb.OAuthRedirectData({ code, state })
                }
            });
            const eventBase64 = BASE64_CODEC.encode(eventMessage.toBinary().buffer);
            logger.info(`posting oauth data to opener`, "oauth_redirect");
            window.opener.postMessage(eventBase64);
            break;
        }
    }
}

const OAuthSucceeded: React.FC<OAuthSucceededProps> = (props: OAuthSucceededProps) => {
    const logger = useLogger();

    let code = props.params.get('code') ?? '';
    const now = new Date();
    const [logsAreOpen, setLogsAreOpen] = React.useState<boolean>(false);

    // Setup autotrigger timestamp
    const autoTriggersAt = React.useMemo(() => new Date(now.getTime() + AUTOTRIGGER_DELAY), []);
    const remainingUntilAutoTrigger = Math.max(autoTriggersAt.getTime(), now.getTime()) - now.getTime();
    React.useEffect(() => {
        logger.info(`setup auto-trigger in ${formatHHMMSS(remainingUntilAutoTrigger / 1000)}`, "oauth_redirect");
        const timeoutId = setTimeout(() => triggerFlow(props.state, code, logger), remainingUntilAutoTrigger);
        return () => clearTimeout(timeoutId);
    }, [props.state, code]);

    // Render provider options
    let providerOptionsSection: React.ReactElement = <div />;
    let codeExpiresAt: Date | undefined = undefined;
    let [codeIsExpired, setCodeIsExpired] = React.useState(false);
    switch (props.state.providerOptions.case) {
        case "salesforceProvider": {
            const expiresAt = props.state.providerOptions.value.expiresAt;
            codeIsExpired = now.getTime() > (expiresAt ?? 0);
            codeExpiresAt = codeIsExpired ? undefined : new Date(Number(expiresAt));
            providerOptionsSection = (
                <div className={page_styles.card_section}>
                    <div className={page_styles.section_entries}>
                        <TextField
                            name="Salesforce Instance URL"
                            value={props.state.providerOptions.value.instanceUrl}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>URL</div>}
                        />
                        <TextField
                            name="Connected App"
                            value={props.state.providerOptions.value.appConsumerKey}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>ID</div>}
                        />
                    </div>
                </div>
            );
        }
    }

    // Determine the time we have left
    let remainingUntilExpiration = codeExpiresAt !== undefined
        ? (Math.max(codeExpiresAt.getTime(), now.getTime()) - now.getTime()) : 0;
    React.useEffect(() => {
        logger.info(`code expires in ${formatHHMMSS(remainingUntilExpiration / 1000)}`, "oauth_redirect");
        const timeoutId = setTimeout(() => setCodeIsExpired(true), remainingUntilExpiration);
        return () => clearTimeout(timeoutId);
    }, [props.state]);

    // Get expiration validation
    let codeExpirationValidation: TextFieldValidationStatus;
    const codeIsEmpty = (props.params.get('code') ?? '').length == 0;
    if (codeIsEmpty) {
        codeExpirationValidation = {
            type: VALIDATION_ERROR,
            value: "code is empty"
        };
    } else {
        codeExpirationValidation = codeIsExpired ? {
            type: VALIDATION_ERROR,
            value: "code is expired"
        } : {
            type: VALIDATION_WARNING,
            value: `code expires ${(formatTimeDifference(codeExpiresAt!, now))}`
        };
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
                    <div className={page_styles.card_header_left_container}>
                        Authorization Succeeded
                    </div>
                    <div className={page_styles.card_header_right_container}>
                        <IconButton
                            variant="invisible"
                            icon={() => (
                                <svg width="16px" height="16px">
                                    <use xlinkHref={`${symbols}#log`} />
                                </svg>
                            )}
                            aria-label="close-overlay"
                            onClick={() => setLogsAreOpen(s => !s)}
                        />
                        {logsAreOpen && <LogViewerInPortal onClose={() => setLogsAreOpen(false)} />}
                    </div>
                </div>
                {providerOptionsSection}
                <div className={page_styles.card_section}>
                    <div className={page_styles.section_entries}>
                        <TextField
                            name="Authorization Code"
                            value={"*".repeat(props.params.get('code')?.length ?? 0)}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>Code</div>}
                            validation={codeExpirationValidation}
                        />
                    </div>
                </div>
                {!codeIsExpired &&
                    <>
                        <div className={page_styles.card_section_info}>
                            Your browser should prompt you to open the native app. You can retry until the code expires.
                        </div>
                        <div className={page_styles.card_actions}>
                            {
                                remainingUntilAutoTrigger == 0
                                    ? <Button
                                        className={page_styles.card_action_continue}
                                        variant="primary"
                                        onClick={() => triggerFlow(props.state, code, logger)}
                                    >
                                        Send to App
                                    </Button>
                                    : <Button
                                        className={page_styles.card_action_continue}
                                        variant="primary"
                                        onClick={() => triggerFlow(props.state, code, logger)}
                                        trailingVisual={() => <div>{Math.ceil(remainingUntilAutoTrigger / 1000)}</div>}
                                    >
                                        Send to App
                                    </Button>
                            }
                        </div>
                    </>
                }
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
    // const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";

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

    if (authState.type == RESULT_OK) {
        return <OAuthSucceeded params={params} state={authState.value} />
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
                <LoggerProvider>
                    <Routes>
                        <Route path="*" element={<RedirectPage />} />
                    </Routes>
                </LoggerProvider>
            </GitHubTheme>
        </BrowserRouter>
    </React.StrictMode>,
);
