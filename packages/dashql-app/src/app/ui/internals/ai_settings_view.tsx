import * as React from 'react';
import * as styles from './ai_settings_view.module.css';

import { KeyIcon, XIcon } from '../../../ui/foundations/symbol_icon.js';

import { Button, ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { ToggleSwitch } from '../../../ui/foundations/toggle_switch.js';
import { TextField } from '../../../ui/foundations/text_field.js';
import { KeyValueListBuilder, KeyValueListElement } from '../../../ui/foundations/keyvalue_list.js';
import { IndicatorStatus, StatusIndicator } from '../../../ui/foundations/status_indicator.js';
import { SegmentedControl } from '../../../ui/foundations/segmented_control.js';
import {
    AIProviderAuth,
    AIProviderAuthType,
    AIProviderHeader,
    AIProviderSettings,
    AppConfig,
    DEFAULT_AI_ENDPOINT_URL,
    DEFAULT_AI_MODEL,
    useAppConfig,
    useAppReconfigure,
} from '../../config/app_config.js';
import { AIClient } from '../../../platform/ai/ai_client.js';
import { useHttpClient } from '../../../platform/http/http_client_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';

const LOG_CTX = 'ai_settings';

interface TestState {
    status: IndicatorStatus;
    text: string;
    error?: string;
}

const INITIAL_TEST_STATE: TestState = {
    status: IndicatorStatus.None,
    text: 'Not tested',
};

function setProvider(
    reconfigure: (m: (c: AppConfig | null) => AppConfig | null) => void,
    next: AIProviderSettings,
) {
    reconfigure(c => c == null ? null : {
        ...c,
        settings: {
            ...(c.settings ?? {}),
            aiProvider: next,
        }
    });
}

/// The authorization methods in the order of the segmented control
const AUTH_TYPES: { type: AIProviderAuthType; label: string }[] = [
    { type: 'none', label: 'None' },
    { type: 'basic', label: 'Basic' },
    { type: 'bearer', label: 'Bearer' },
];

const HeaderKeyIcon = () => <div>Header</div>;
const HeaderValueIcon = () => <div>Value</div>;
const UrlIcon = () => <div>URL</div>;
const ModelIcon = () => <div>Model</div>;
const UsernameIcon = () => <div>ID</div>;

function headersToKeyValueList(headers: AIProviderHeader[]): KeyValueListElement[] {
    return headers.map(h => ({ key: h.name, value: h.value }));
}

function keyValueListToHeaders(elements: KeyValueListElement[]): AIProviderHeader[] {
    return elements.map(e => ({ name: e.key, value: e.value }));
}

export function AISettingsView(props: { onClose: () => void; }) {
    const config = useAppConfig();
    const reconfigure = useAppReconfigure();
    const httpClient = useHttpClient();
    const logger = useLogger();

    const stored = config?.settings?.aiProvider;
    const enabled = stored?.enabled === true;
    const endpointUrl = stored?.endpointUrl ?? DEFAULT_AI_ENDPOINT_URL;
    const model = stored?.model ?? DEFAULT_AI_MODEL;
    const providerHeaders = stored?.headers ?? [];
    const auth: AIProviderAuth = stored?.auth ?? {};
    const authType: AIProviderAuthType = auth.type ?? 'none';
    const provider: AIProviderSettings = { enabled, endpointUrl, model, headers: providerHeaders, auth };

    const [testState, setTestState] = React.useState<TestState>(INITIAL_TEST_STATE);
    const abortRef = React.useRef<AbortController | null>(null);

    React.useEffect(() => () => abortRef.current?.abort(), []);

    const toggleEnabled = () => {
        setProvider(reconfigure, { ...provider, enabled: !enabled });
    };

    const onChangeEndpoint = (e: React.ChangeEvent<HTMLInputElement>) => {
        setProvider(reconfigure, { ...provider, endpointUrl: e.target.value });
    };
    const onChangeModel = (e: React.ChangeEvent<HTMLInputElement>) => {
        setProvider(reconfigure, { ...provider, model: e.target.value });
    };
    const updateAuth = (patch: AIProviderAuth) => {
        setProvider(reconfigure, { ...provider, auth: { ...auth, ...patch } });
    };
    const modifyHeaders = (updater: (prev: KeyValueListElement[]) => KeyValueListElement[]) => {
        const current = headersToKeyValueList(providerHeaders);
        const next = updater(current);
        setProvider(reconfigure, { ...provider, headers: keyValueListToHeaders(next) });
    };

    const runTest = async () => {
        if (httpClient == null || logger == null) return;
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setTestState({ status: IndicatorStatus.Running, text: 'Testing…' });
        try {
            const cleanHeaders: AIProviderHeader[] = providerHeaders.filter(h => h.name.trim().length > 0);
            const client = new AIClient(logger, httpClient, {
                endpointUrl,
                model,
                headers: cleanHeaders,
                auth,
            });
            const models = await client.listModels(ac.signal);
            if (ac.signal.aborted) return;
            setTestState({
                status: IndicatorStatus.Succeeded,
                text: `Reachable — ${models.length} model${models.length === 1 ? '' : 's'} available`,
            });
        } catch (e: any) {
            if (ac.signal.aborted) return;
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn('AI provider test failed', { error: msg }, LOG_CTX);
            setTestState({ status: IndicatorStatus.Failed, text: 'Failed', error: msg });
        }
    };

    return (
        <div className={styles.settings_root}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>AI Provider Settings</div>
                </div>
                <div className={styles.header_right_container}>
                    <ToggleSwitch
                        size="medium"
                        checked={enabled}
                        onClick={toggleEnabled}
                        disabled={config == null}
                        aria-label="Enable AI features"
                    />
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="close-overlay"
                        onClick={props.onClose}
                    >
                        <XIcon />
                    </IconButton>
                </div>
            </div>
            <div className={styles.body}>
                <div className={styles.status_container}>
                    <div className={styles.status_section}>
                        <div className={styles.status_bar}>
                            <div className={styles.status_indicator}>
                                <StatusIndicator
                                    className={styles.status_indicator_spinner}
                                    status={testState.status}
                                />
                            </div>
                            <div className={styles.status_text}>{testState.text}</div>
                            {testState.error && (
                                <div className={styles.status_error}>{testState.error}</div>
                            )}
                        </div>
                        <Button
                            variant={ButtonVariant.Primary}
                            size={ButtonSize.Small}
                            onClick={runTest}
                            disabled={!enabled || httpClient == null || testState.status === IndicatorStatus.Running}
                        >
                            Test
                        </Button>
                    </div>
                </div>
                <div className={styles.section}>
                    <div className={styles.section_layout}>
                        <TextField
                            className={styles.grid_column_1}
                            name="Endpoint URL"
                            caption="Base URL of the OpenAI-compatible server"
                            value={endpointUrl}
                            placeholder={DEFAULT_AI_ENDPOINT_URL}
                            leadingVisual={UrlIcon}
                            onChange={onChangeEndpoint}
                            disabled={!enabled}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Model"
                            caption="Model identifier used for chat completions"
                            value={model}
                            placeholder={DEFAULT_AI_MODEL}
                            leadingVisual={ModelIcon}
                            onChange={onChangeModel}
                            disabled={!enabled}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
                <div className={styles.section}>
                    <div className={styles.section_layout}>
                        <div className={styles.section_header}>
                            <SegmentedControl
                                aria-label="Authorization method"
                                onChange={index => updateAuth({ type: AUTH_TYPES[index].type })}
                            >
                                {AUTH_TYPES.map(t => (
                                    <SegmentedControl.Button
                                        key={t.type}
                                        selected={authType === t.type}
                                        disabled={!enabled}
                                    >
                                        {t.label}
                                    </SegmentedControl.Button>
                                ))}
                            </SegmentedControl>
                        </div>
                        {authType === 'none' && (
                            <div className={styles.auth_hint}>
                                Requests are sent without an Authorization header
                            </div>
                        )}
                        {authType === 'basic' && (
                            <>
                                <TextField
                                    className={styles.grid_column_1}
                                    name="Username"
                                    caption="Username for HTTP Basic authorization"
                                    value={auth.username ?? ''}
                                    leadingVisual={UsernameIcon}
                                    onChange={e => updateAuth({ username: e.target.value })}
                                    disabled={!enabled}
                                    autoComplete={false}
                                    logContext={LOG_CTX}
                                />
                                <TextField
                                    name="Password"
                                    caption="Password for HTTP Basic authorization"
                                    value={auth.password ?? ''}
                                    leadingVisual={KeyIcon}
                                    onChange={e => updateAuth({ password: e.target.value })}
                                    disabled={!enabled}
                                    autoComplete={false}
                                    logContext={LOG_CTX}
                                />
                            </>
                        )}
                        {authType === 'bearer' && (
                            <TextField
                                className={styles.grid_column_1_span_2}
                                name="Token"
                                caption="Token sent as Authorization: Bearer <token>"
                                value={auth.token ?? ''}
                                leadingVisual={KeyIcon}
                                onChange={e => updateAuth({ token: e.target.value })}
                                disabled={!enabled}
                                autoComplete={false}
                                logContext={LOG_CTX}
                            />
                        )}
                    </div>
                </div>
                <div className={styles.section}>
                    <div className={styles.section_layout}>
                        <KeyValueListBuilder
                            className={styles.grid_column_1_span_2}
                            title="Additional Headers"
                            caption="Extra HTTP headers added to each request"
                            keyIcon={HeaderKeyIcon}
                            valueIcon={HeaderValueIcon}
                            addButtonLabel="Add Header"
                            elements={headersToKeyValueList(providerHeaders)}
                            modifyElements={modifyHeaders}
                            disabled={!enabled}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
