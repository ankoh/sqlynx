import * as React from 'react';
import * as proto from '@ankoh/sqlynx-pb';
import * as styles from './view/banner_page.module.css';
import * as symbols from '../static/svg/symbols.generated.svg';

import { IconButton } from '@primer/react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom';

import { BASE64_CODEC } from './utils/base64.js';
import { Result, RESULT_ERROR, RESULT_OK } from './utils/result.js';
import { SQLYNX_VERSION } from './globals.js';
import { Button, ButtonVariant } from './view/foundations/button.js';
import { TextField, TextFieldValidationStatus, VALIDATION_ERROR, VALIDATION_WARNING } from './view/foundations/text_field.js';
import { GitHubTheme } from './github_theme.js';
import { formatHHMMSS, formatTimeDifference } from './utils/format.js';
import { LogViewerOverlay } from './view/log_viewer.js';
import { LoggerProvider, useLogger } from './platform/logger_provider.js';
import { Logger } from './platform/logger.js';

import '../static/fonts/fonts.css';
import './globals.css';
import { VersionViewerOverlay } from './view/version_viewer.js';
import { PackageIcon } from '@primer/octicons-react';
import { AnchorAlignment, AnchorSide } from './view/foundations/anchored_position.js';
import { OverlaySize } from './view/foundations/overlay.js';
import * as page_styles from './view/banner_page.module.css';

const AUTOTRIGGER_DELAY = 2000;

const LOG_CTX = "oauth_redirect";

interface OAuthSucceededProps {
    params: URLSearchParams;
    state: proto.sqlynx_oauth.pb.OAuthState;
}

function buildDeepLink(eventBase64: string) {
    return new URL(`sqlynx://localhost?data=${eventBase64}`);
}

function triggerFlow(state: proto.sqlynx_oauth.pb.OAuthState, eventBase64: string, logger: Logger) {
    switch (state.flowVariant) {
        case proto.sqlynx_oauth.pb.OAuthFlowVariant.NATIVE_LINK_FLOW: {
            const deepLink = buildDeepLink(eventBase64).toString();
            logger.info(`opening deep link`, LOG_CTX);
            window.open(deepLink, '_self');
            break;
        }
        case proto.sqlynx_oauth.pb.OAuthFlowVariant.WEB_OPENER_FLOW: {
            if (!window.opener) {
                logger.error("window opener is undefined", LOG_CTX);
                return;
            }
            logger.info(`posting oauth data to opener`, LOG_CTX);
            window.opener.postMessage(eventBase64);
            break;
        }
    }
}

const OAuthSucceeded: React.FC<OAuthSucceededProps> = (props: OAuthSucceededProps) => {
    const logger = useLogger();

    const code = props.params.get('code') ?? '';
    const now = new Date();
    const [logsAreOpen, setLogsAreOpen] = React.useState<boolean>(false);

    // Encode the event as base64
    const eventBase64 = React.useMemo(() => {
        const eventMessage = new proto.sqlynx_app_event.pb.AppEventData({
            data: {
                case: "oauthRedirect",
                value: new proto.sqlynx_oauth.pb.OAuthRedirectData({ code, state: props.state })
            }
        });
        return BASE64_CODEC.encode(eventMessage.toBinary().buffer);
    }, [code, props.state]);

    // Setup autotrigger
    const skipAutoTrigger = props.state.flowVariant == proto.sqlynx_oauth.pb.OAuthFlowVariant.NATIVE_LINK_FLOW && props.state.debugMode;
    const autoTriggersAt = React.useMemo(() => new Date(now.getTime() + AUTOTRIGGER_DELAY), []);
    const remainingUntilAutoTrigger = Math.max(autoTriggersAt.getTime(), now.getTime()) - now.getTime();
    React.useEffect(() => {
        // Skip auto trigger for native apps in debug mode
        if (skipAutoTrigger) {
            logger.info(`skip auto-trigger for native app in debug mode`, LOG_CTX);
            return () => { };
        } else {
            logger.info(`setup auto-trigger in ${formatHHMMSS(remainingUntilAutoTrigger / 1000)}`, LOG_CTX);
            const timeoutId = setTimeout(() => triggerFlow(props.state, eventBase64, logger), remainingUntilAutoTrigger);
            return () => clearTimeout(timeoutId);
        }
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
                <div className={styles.card_section}>
                    <div className={styles.section_entries}>
                        <TextField
                            name="Salesforce Instance URL"
                            value={props.state.providerOptions.value.instanceUrl}
                            leadingVisual={() => <div>URL</div>}
                            logContext={LOG_CTX}
                            readOnly
                            disabled
                        />
                        <TextField
                            name="Connected App"
                            value={props.state.providerOptions.value.appConsumerKey}
                            leadingVisual={() => <div>ID</div>}
                            logContext={LOG_CTX}
                            readOnly
                            disabled
                        />
                    </div>
                </div>
            );
        }
    }

    // Determine the time we have left
    const remainingUntilExpiration = codeExpiresAt !== undefined
        ? (Math.max(codeExpiresAt.getTime(), now.getTime()) - now.getTime()) : 0;
    React.useEffect(() => {
        logger.info(`code expires in ${formatHHMMSS(remainingUntilExpiration / 1000)}`, LOG_CTX);
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

    // Get flow continuation
    let flowContinuation: React.ReactElement = <div />;
    switch (props.state.flowVariant) {
        case proto.sqlynx_oauth.pb.OAuthFlowVariant.WEB_OPENER_FLOW: {
            break;
        }
        case proto.sqlynx_oauth.pb.OAuthFlowVariant.NATIVE_LINK_FLOW: {
            if (props.state.debugMode) {
                flowContinuation = (
                    <div className={styles.card_section}>
                        <div className={styles.section_entries}>
                            <div className={styles.section_description}>
                                The initiator is a native app in debug mode which cannot register as deep link handler.
                                Copy the following url and paste it anywhere into the app window.
                            </div>
                            <TextField
                                name="Native OAuth Callback"
                                value={buildDeepLink(eventBase64).toString()}
                                leadingVisual={() => <div>URL</div>}
                                logContext={LOG_CTX}
                                readOnly
                                disabled
                            />
                        </div>
                    </div>
                );

            } else {
                flowContinuation = (
                    <div className={styles.card_section}>
                        <div className={styles.section_description}>
                            Your browser should prompt you to open the native app. You can retry until the code expires.
                        </div>
                        <div className={styles.card_actions}>
                            <div className={styles.card_actions_right}>
                            {
                                remainingUntilAutoTrigger == 0
                                    ? <Button
                                        variant={ButtonVariant.Primary}
                                        onClick={() => triggerFlow(props.state, eventBase64, logger)}
                                    >
                                        Send to App
                                    </Button>
                                    : <Button
                                        variant={ButtonVariant.Primary}
                                        onClick={() => triggerFlow(props.state, eventBase64, logger)}
                                        trailingVisual={() => <div>{Math.ceil(remainingUntilAutoTrigger / 1000)}</div>}
                                    >
                                        Send to App
                                    </Button>
                            }
                            </div>
                        </div>
                    </div>
                );
            }
            break;
        }
    }

    // Construct the page
    return (
        <div className={styles.page}>
            <div className={page_styles.banner_and_content_container}>
                <div className={styles.banner_container}>
                    <div className={styles.banner_logo}>
                        <svg width="100%" height="100%">
                            <use xlinkHref={`${symbols}#sqlynx-inverted`} />
                        </svg>
                    </div>
                    <div className={styles.banner_text_container}>
                        <div className={styles.banner_title}>sqlynx</div>
                        <div className={styles.app_version}>version {SQLYNX_VERSION}</div>
                    </div>
                </div>
                <div className={page_styles.content_container}>
                    <div className={styles.card}>
                        <div className={styles.card_header}>
                            <div className={styles.card_header_left_container}>
                                Authorization Succeeded
                            </div>
                            <div className={styles.card_header_right_container}>
                                <LogViewerOverlay
                                    isOpen={logsAreOpen}
                                    onClose={() => setLogsAreOpen(false)}
                                    renderAnchor={(p: object) => (
                                        <IconButton
                                            {...p}
                                            variant="invisible"
                                            icon={() => (
                                                <svg width="16px" height="16px">
                                                    <use xlinkHref={`${symbols}#log`} />
                                                </svg>
                                            )}
                                            aria-label="close-overlay"
                                            onClick={() => setLogsAreOpen(s => !s)}
                                        />
                                    )}
                                    side={AnchorSide.OutsideBottom}
                                    align={AnchorAlignment.End}
                                    anchorOffset={16}
                                    overlayProps={{
                                        width: OverlaySize.L,
                                        height: OverlaySize.M
                                    }}
                                />
                            </div>
                        </div>
                        {providerOptionsSection}
                        <div className={styles.card_section}>
                            <div className={styles.section_entries}>
                                <TextField
                                    name="Authorization Code"
                                    value={code ?? ""}
                                    leadingVisual={() => <div>Code</div>}
                                    validation={codeExpirationValidation}
                                    logContext={LOG_CTX}
                                    readOnly
                                    disabled
                                    concealed
                                />
                            </div>
                        </div>
                        {flowContinuation}
                    </div>
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
        <div className={styles.page}>
            <div className={styles.banner_container}>
                <div className={styles.banner_logo}>
                    <svg width="100%" height="100%">
                        <use xlinkHref={`${symbols}#sqlynx-inverted`} />
                    </svg>
                </div>
                <div className={styles.banner_text_container}>
                    <div className={styles.banner_title}>sqlynx</div>
                    <div className={styles.app_version}>version {SQLYNX_VERSION}</div>
                </div>
            </div>
            <div className={styles.card_container}>
                <div className={styles.card_header}>
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
