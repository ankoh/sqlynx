import * as React from 'react';
import symbols from '@ankoh/dashql-svg-symbols';
import * as baseStyles from '../ui/banner/banner_page.module.css';
import * as styles from './oauth_redirect.module.css';

import type { OAuthState, AppEventData } from '../oauth_types.js';

import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom';

import { AnchorAlignment, AnchorSide } from '../ui/foundations/anchored_position.js';
import { BASE64URL_CODEC } from '../utils/base64.js';
import { Button, ButtonSize, ButtonVariant, IconButton } from '../ui/foundations/button.js';
import { CopyToClipboardButton } from '../utils/clipboard.js';
import { DASHQL_VERSION } from '../globals.js';
import { FlavorLogo, FlavorProvider, useAppFlavor } from '../app/flavor/flavor_provider.js';
import { GitHubTheme } from '../theme/github_theme.js';
import { LogsOverlay } from '../ui/logs_overlay.js';
import { Logger, stringifyError } from '../platform/logger/logger.js';
import { LoggerProvider, useLogger } from '../platform/logger/logger_provider.js';
import { Result, RESULT_ERROR, RESULT_OK } from '../utils/result.js';
import { TextField, TextFieldValidationStatus, VALIDATION_ERROR, VALIDATION_WARNING } from '../ui/foundations/text_field.js';
import { classNames } from '../utils/classnames.js';
import { formatHHMMSS, formatTimeDifference } from '../utils/format.js';
import { APP_EVENT_POST_MESSAGE_KIND, OAUTH_BROADCAST_CHANNEL } from '../platform/events/event.js';
import { isAllowedOAuthCallbackUrl, validateOAuthRedirectState } from './oauth_redirect_utils.js';
import { applyFlavorToDocument, getAppFlavor } from '../app/flavor/flavor_resolution.js';

import '../../static/fonts/fonts.css';
import '../styles/globals.css';
import '../styles/flavors/sidb.css';

const AUTO_TRIGGER_DELAY = 2000;
const AUTO_TRIGGER_COUNTER_INTERVAL = 200;

const LOG_CTX = "oauth_redirect";

interface OAuthSucceededProps {
    params: URLSearchParams;
    state: OAuthState;
}

function buildDeepLink(eventBase64: string) {
    return new URL(`dashql://localhost?data=${eventBase64}`);
}

function triggerFlow(state: OAuthState, eventBase64: string, deepLink: string, logger: Logger) {
    switch (state.flowVariant) {
        case "NATIVE_LINK_FLOW": {
            logger.info(`Opening OAuth deep link`, {}, LOG_CTX);
            window.open(deepLink, '_self');
            break;
        }
        case "WEB_OPENER_FLOW": {
            // COOP (Cross-Origin-Opener-Policy: same-origin) severs window.opener after
            // the popup navigates to Salesforce. Use BroadcastChannel as the primary path
            // since it works same-origin regardless of COOP, and fall back to postMessage
            // for environments that lack BroadcastChannel support.
            logger.info(`Posting OAuth result via broadcast channel`, {}, LOG_CTX);
            const channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL);
            channel.postMessage(eventBase64);
            channel.close();
            if (window.opener) {
                window.opener.postMessage(
                    { kind: APP_EVENT_POST_MESSAGE_KIND, data: eventBase64 },
                    window.location.origin,
                );
            }
            // Close self — opener.close() can be blocked by COOP after the cross-origin
            // bounce through Salesforce, but window.close() on the popup itself works
            // because the popup was opened via window.open().
            window.close();
            break;
        }
    }
}

/// The banner with the logo and the app version.
/// A wordmark replaces both the logo and the name.
const OAuthBanner: React.FC = () => {
    const flavor = useAppFlavor();
    return (
        <div className={baseStyles.banner_container}>
            {!flavor.logo.wordmark && (
                <div className={baseStyles.banner_logo}>
                    <svg width="100%" height="100%">
                        <use xlinkHref={`${symbols}#${flavor.logo.symbol}`} />
                    </svg>
                </div>
            )}
            <div className={baseStyles.banner_text_container}>
                <div className={baseStyles.banner_title}>
                    {flavor.logo.wordmark ? <FlavorLogo height={22} /> : flavor.displayName.toLowerCase()}
                </div>
                <div className={baseStyles.app_version}>version {DASHQL_VERSION}</div>
            </div>
        </div>
    );
};

const OAuthSucceeded: React.FC<OAuthSucceededProps> = (props: OAuthSucceededProps) => {
    const logger = useLogger();

    const code = props.params.get('code') ?? undefined;
    const oauthError = props.params.get('error') ?? undefined;
    const oauthErrorDescription = props.params.get('error_description') ?? undefined;
    const now = new Date();
    const [logsAreOpen, setLogsAreOpen] = React.useState<boolean>(false);

    // Encode the event as base64
    const { eventBase64, deepLink } = React.useMemo(() => {
        const eventMessage: AppEventData = {
            oauthRedirect: {
                code,
                error: oauthError,
                errorDescription: oauthErrorDescription,
                state: props.state
            }
        };
        // Encode to JSON
        const eventJson = JSON.stringify(eventMessage);
        const eventBuffer = new TextEncoder().encode(eventJson);
        const event = BASE64URL_CODEC.encode(eventBuffer.buffer);
        return {
            eventBase64: event,
            deepLink: buildDeepLink(event).toString(),
        }
    }, [code, oauthError, oauthErrorDescription, props.state]);

    // Setup auto-trigger
    const skipAutoTrigger = props.state.flowVariant == "NATIVE_LINK_FLOW" && props.state.debugMode;
    const autoTriggersAt = React.useMemo(() => new Date(now.getTime() + AUTO_TRIGGER_DELAY), []);
    const [remainingUntilAutoTrigger, setRemainingUntilAutoTrigger] = React.useState<number>(() => Math.max(autoTriggersAt.getTime(), now.getTime()) - now.getTime());
    const [wasTriggered, setWasTriggered] = React.useState<boolean>(false);

    React.useEffect(() => {
        // Skip auto trigger for native apps in debug mode
        if (skipAutoTrigger) {
            logger.info(`Skipping auto-trigger for native app in debug mode`, {}, LOG_CTX);
            return () => { };
        } else {
            logger.info("Setup auto-trigger", { "remaining": formatHHMMSS(remainingUntilAutoTrigger / 1000) }, LOG_CTX);
            const timeoutId = setTimeout(() => {
                triggerFlow(props.state, eventBase64, deepLink, logger);
                setWasTriggered(true);
            }, remainingUntilAutoTrigger);
            const updaterId: { current: unknown | null } = { current: null };

            const updateRemaining = () => {
                const now = new Date();
                const remainder = Math.max(autoTriggersAt.getTime(), now.getTime()) - now.getTime();
                setRemainingUntilAutoTrigger(remainder);
                if (remainder > AUTO_TRIGGER_COUNTER_INTERVAL) {
                    updaterId.current = setTimeout(updateRemaining, AUTO_TRIGGER_COUNTER_INTERVAL);
                }
            };
            updaterId.current = setTimeout(updateRemaining, AUTO_TRIGGER_COUNTER_INTERVAL);

            return () => {
                clearTimeout(timeoutId);
                if (updaterId.current != null) {
                    clearTimeout(updaterId.current as any);
                }
            }
        }
    }, [props.state, code]);

    // Render provider options
    let providerOptionsSection: React.ReactElement = <div />;
    let codeExpiresAt: Date | undefined = undefined;
    // eslint-disable-next-line prefer-const
    let [codeIsExpired, setCodeIsExpired] = React.useState(false);
    if (props.state.salesforceProvider) {
        const salesforceProvider = props.state.salesforceProvider;
        const expiresAt = salesforceProvider.expiresAt;
        codeIsExpired = now.getTime() > (expiresAt ?? 0);
        codeExpiresAt = codeIsExpired ? undefined : new Date(Number(expiresAt));
        providerOptionsSection = (
            <div className={baseStyles.card_section}>
                <div className={baseStyles.section_entries}>
                    <TextField
                        name="Salesforce Instance URL"
                        value={salesforceProvider.instanceUrl}
                        leadingVisual={() => <div>URL</div>}
                        logContext={LOG_CTX}
                        readOnly
                        disabled
                    />
                    <TextField
                        name="Connected App"
                        value={salesforceProvider.appConsumerKey}
                        leadingVisual={() => <div>ID</div>}
                        logContext={LOG_CTX}
                        readOnly
                        disabled
                    />
                </div>
            </div>
        );
    }

    // Determine the time we have left
    const remainingUntilExpiration = codeExpiresAt !== undefined
        ? (Math.max(codeExpiresAt.getTime(), now.getTime()) - now.getTime()) : 0;
    React.useEffect(() => {
        logger.info("Determining code expiration", { "remaining": formatHHMMSS(remainingUntilExpiration / 1000) }, LOG_CTX);
        const timeoutId = setTimeout(() => setCodeIsExpired(true), remainingUntilExpiration);
        return () => clearTimeout(timeoutId);
    }, [props.state]);

    // Get expiration validation
    let codeExpirationValidation: TextFieldValidationStatus;
    const codeIsEmpty = !code;
    if (oauthError) {
        codeExpirationValidation = {
            type: VALIDATION_ERROR,
            value: oauthErrorDescription || oauthError,
        };
    } else if (codeIsEmpty) {
        codeExpirationValidation = {
            type: VALIDATION_ERROR,
            value: "Code is empty"
        };
    } else {
        codeExpirationValidation = codeIsExpired ? {
            type: VALIDATION_ERROR,
            value: "Code is expired"
        } : {
            type: VALIDATION_WARNING,
            value: `Code expires ${(formatTimeDifference(codeExpiresAt!, now))}`
        };
    }

    // Get flow continuation
    let flowContinuation: React.ReactElement = <div />;
    switch (props.state.flowVariant) {
        case "WEB_OPENER_FLOW": {
            flowContinuation = (
                <div className={baseStyles.card_section}>
                    <div className={baseStyles.section_entries}>
                        <div className={baseStyles.section_description}>
                            The authorization result was sent to the app automatically.
                            If the app did not receive it, copy the event data below and paste it into the app window.
                        </div>
                        <TextField
                            name="OAuth Event Data"
                            value={eventBase64}
                            leadingVisual={() => <div>Data</div>}
                            logContext={LOG_CTX}
                            readOnly
                            disabled
                            concealed
                        />
                    </div>
                    <div className={baseStyles.card_actions}>
                        <div className={baseStyles.card_actions_right}>
                            <CopyToClipboardButton
                                variant={ButtonVariant.Default}
                                size={ButtonSize.Medium}
                                logContext={LOG_CTX}
                                value={eventBase64}
                                aria-label="copy-event-data"
                                aria-labelledby=""
                            />
                        </div>
                    </div>
                </div>
            );
            break;
        }
        case "NATIVE_LINK_FLOW": {
            if (props.state.debugMode) {
                flowContinuation = (
                    <div className={baseStyles.card_section}>
                        <div className={baseStyles.section_entries}>
                            <div className={baseStyles.section_description}>
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
                    <div className={baseStyles.card_section}>
                        <div className={baseStyles.section_entries}>
                            <div className={baseStyles.section_description}>
                                Your browser should prompt you to open the native app. You can retry until the code expires.
                            </div>
                        </div>
                        <div className={baseStyles.card_actions}>
                            <div className={baseStyles.card_actions_right}>
                                <CopyToClipboardButton
                                    variant={ButtonVariant.Primary}
                                    size={ButtonSize.Medium}
                                    logContext={LOG_CTX}
                                    value={deepLink}
                                    aria-label="copy-deeplink"
                                    aria-labelledby=""
                                />
                                {
                                    wasTriggered
                                        ? <Button
                                            variant={ButtonVariant.Primary}
                                            onClick={() => triggerFlow(props.state, eventBase64, deepLink, logger)}
                                        >
                                            Open in App
                                        </Button>
                                        : <Button
                                            variant={ButtonVariant.Primary}
                                            onClick={() => triggerFlow(props.state, eventBase64, deepLink, logger)}
                                            trailingVisual={() => <div>{Math.ceil(remainingUntilAutoTrigger / 1000)}</div>}
                                        >
                                            Open in App
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
        <div className={baseStyles.page}>
            <div className={classNames(baseStyles.banner_and_content_container, styles.banner_and_content_container)}>
                <OAuthBanner />
                <div className={baseStyles.content_container}>
                    <div className={baseStyles.card}>
                        <div className={baseStyles.card_header}>
                            <div className={baseStyles.card_header_left_container}>
                                <div className={baseStyles.card_header_left_title}>
                                    {oauthError ? 'Authorization Failed' : 'Authorization Succeeded'}
                                </div>
                            </div>
                            <div className={baseStyles.card_header_right_container}>
                                <LogsOverlay
                                    isOpen={logsAreOpen}
                                    onClose={() => setLogsAreOpen(false)}
                                    renderAnchor={(p: object) => (
                                        <IconButton
                                            {...p}
                                            variant={ButtonVariant.Invisible}
                                            aria-label="open-logs"
                                            onClick={() => setLogsAreOpen(s => !s)}
                                        >
                                            <svg width="16px" height="16px">
                                                <use xlinkHref={`${symbols}#processor`} />
                                            </svg>
                                        </IconButton>
                                    )}
                                    side={AnchorSide.OutsideBottom}
                                    align={AnchorAlignment.End}
                                    anchorOffset={16}
                                />
                            </div>
                        </div>
                        {providerOptionsSection}
                        <div className={baseStyles.card_section}>
                            <div className={baseStyles.section_entries}>
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
        <div className={baseStyles.page}>
            <OAuthBanner />
            <div className={baseStyles.card}>
                <div className={baseStyles.card_header}>
                    <div>Authorization Failed</div>
                </div>
                {stringifyError(props.error)}
            </div>
        </div>
    );
}


interface RedirectPageProps { }


const RedirectPage: React.FC<RedirectPageProps> = (_props: RedirectPageProps) => {
    const [params, _setParams] = useSearchParams();
    const state = params.get("state") ?? "";

    const authState = React.useMemo<Result<OAuthState>>(() => {
        try {
            const authStateBuffer = BASE64URL_CODEC.decode(state);
            const authStateString = new TextDecoder().decode(authStateBuffer);
            const parsed = JSON.parse(authStateString) as OAuthState;
            validateOAuthRedirectState(parsed);
            return {
                type: RESULT_OK,
                value: parsed,
            };
        } catch (e: any) {
            return {
                type: RESULT_ERROR,
                error: new Error(stringifyError(e)),
            };
        }
    }, [state]);

    // If the state encodes a callbackUrl on a different origin, redirect the popup there
    // before doing anything else. This lets localhost dev servers receive the OAuth code
    // via BroadcastChannel even though the registered redirect_uri is dashql.app/oauth.html.
    if (authState.type == RESULT_OK) {
        const callbackUrl = authState.value.callbackUrl;
        if (callbackUrl) {
            if (!isAllowedOAuthCallbackUrl(callbackUrl, new URL(window.location.href))) {
                return <OAuthFailed error={new Error('OAuth callback URL is not allowed')} />;
            }
            const target = new URL(callbackUrl);
            if (target.origin !== window.location.origin) {
                // Forward all query params (code, state, error, ...) to the target origin
                target.search = window.location.search;
                window.location.replace(target.toString());
                return <div />;
            }
        }
    }

    if (authState.type == RESULT_OK) {
        return <OAuthSucceeded params={params} state={authState.value} />
    } else {
        return <OAuthFailed error={authState.error} />
    }
};

const APP_FLAVOR = getAppFlavor();
applyFlavorToDocument(APP_FLAVOR);

const element = document.getElementById('root');
const root = createRoot(element!);
root.render(
    <React.StrictMode>
        <BrowserRouter>
            <FlavorProvider flavor={APP_FLAVOR}>
                <GitHubTheme>
                    <LoggerProvider>
                        <Routes>
                            <Route path="*" element={<RedirectPage />} />
                        </Routes>
                    </LoggerProvider>
                </GitHubTheme>
            </FlavorProvider>
        </BrowserRouter>
    </React.StrictMode>,
);
