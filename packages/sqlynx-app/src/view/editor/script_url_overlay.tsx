import React from 'react';
import LZString from 'lz-string';
import classNames from 'classnames';

import { TextInput, AnchoredOverlay, Box, IconButton, ToggleSwitch } from '@primer/react';
import { CheckIcon, PaperclipIcon } from '@primer/octicons-react';

import { sleep } from '../../utils/sleep';
import { ScriptData, ScriptKey } from '../../scripts/script_state';
import { useSelectedScriptState } from '../../scripts/script_state_provider';
import { useSalesforceAuthState } from '../../connectors/salesforce_auth_state';
import { ConnectorType } from '../../connectors/connector_info';
import {
    writeHyperConnectorParams,
    writeLocalConnectorParams,
    writeSalesforceConnectorParams,
} from '../../connectors/connector_url_params';

import styles from './script_url_overlay.module.css';

const COPY_CHECKMARK_DURATION_MS = 1000;

const encodeScript = (url: URLSearchParams, key: string, data: ScriptData) => {
    if (data.script) {
        const text = data.script.toString();
        const textBase64 = LZString.compressToBase64(text);
        url.set(key, encodeURIComponent(textBase64));
    }
};

interface Props {
    className?: string;
    isOpen: boolean;
    setIsOpen: (v: boolean) => void;
}

interface State {
    url: URL | null;
    urlText: string | null;
    copyStartedAt: Date | null;
    copyFinishedAt: Date | null;
    copyError: any | null;
    uiResetAt: Date | null;
}

export const ScriptURLOverlay: React.FC<Props> = (props: Props) => {
    const scriptState = useSelectedScriptState();
    const [embedConnectorInfo, setEmbedConnectorInfo] = React.useState<boolean>(true);
    const [state, setState] = React.useState<State>(() => ({
        url: null,
        urlText: null,
        copyStartedAt: null,
        copyFinishedAt: null,
        copyError: null,
        uiResetAt: null,
    }));
    const salesforceAuth = useSalesforceAuthState();

    React.useEffect(() => {
        const baseURL = process.env.SQLYNX_APP_URL;
        const url = new URL(baseURL ?? '');
        url.searchParams.set('connector', 'local');
        if (embedConnectorInfo) {
            switch (scriptState?.connectorInfo.connectorType) {
                case ConnectorType.LOCAL_SCRIPT:
                    writeLocalConnectorParams(url.searchParams);
                    break;
                case ConnectorType.HYPER_DATABASE:
                    writeHyperConnectorParams(url.searchParams);
                    break;
                case ConnectorType.SALESFORCE_DATA_CLOUD:
                    writeSalesforceConnectorParams(url.searchParams, salesforceAuth);
                    break;
            }
        }
        const mainScript = scriptState?.scripts[ScriptKey.MAIN_SCRIPT] ?? null;
        const schemaScript = scriptState?.scripts[ScriptKey.SCHEMA_SCRIPT] ?? null;
        if (mainScript?.script) {
            encodeScript(url.searchParams, 'script', mainScript);
        }
        if (schemaScript?.script) {
            encodeScript(url.searchParams, 'schema', schemaScript);
        }
        setState({
            url,
            urlText: url.toString(),
            copyStartedAt: null,
            copyFinishedAt: null,
            copyError: null,
            uiResetAt: null,
        });
    }, [
        scriptState?.scripts[ScriptKey.MAIN_SCRIPT],
        scriptState?.scripts[ScriptKey.SCHEMA_SCRIPT],
        embedConnectorInfo,
    ]);

    // Copy the url to the clipboard
    const copyURL = React.useCallback(
        (event: React.MouseEvent) => {
            if (!state.url) return;
            event.stopPropagation();
            const urlText = state.url.toString();
            setState(s => ({
                ...s,
                copyStartedAt: new Date(),
                copyFinishedAt: null,
                copyError: null,
                uiResetAt: null,
            }));
            const copy = async () => {
                try {
                    await navigator.clipboard.writeText(urlText);
                    setState(s => ({
                        ...s,
                        copyFinishedAt: new Date(),
                        copyError: null,
                    }));
                } catch (e: any) {
                    setState(s => ({
                        ...s,
                        copyFinishedAt: new Date(),
                        copyError: e,
                    }));
                }
                await sleep(COPY_CHECKMARK_DURATION_MS);
                setState(s => ({
                    ...s,
                    uiResetAt: new Date(),
                }));
            };
            copy();
        },
        [state, setState],
    );

    const toggleConnectorEmbedding = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        setEmbedConnectorInfo(s => !s);
    }, []);

    const anchorRef = React.createRef<HTMLDivElement>();
    const buttonRef = React.createRef<HTMLAnchorElement>();
    return (
        <AnchoredOverlay
            renderAnchor={() => <div ref={anchorRef} />}
            open={props.isOpen}
            onClose={() => props.setIsOpen(false)}
            anchorRef={anchorRef}
            align="end"
            overlayProps={{
                initialFocusRef: buttonRef,
            }}
        >
            <Box className={classNames(styles.sharing_overlay, props.className)}>
                <div className={styles.sharing_title}>Save Query as Link</div>
                <div className={styles.sharing_url}>
                    <TextInput className={styles.sharing_url} disabled={true} value={state.urlText ?? ''} />
                    <IconButton
                        ref={buttonRef}
                        className={styles.sharing_button}
                        icon={state.copyFinishedAt != null && state.uiResetAt == null ? CheckIcon : PaperclipIcon}
                        onClick={copyURL}
                        aria-labelledby="copy-to-clipboard"
                    />
                    <div className={styles.sharing_url_stats}>{state.urlText?.length ?? 0} characters</div>
                </div>
                <div className={styles.sharing_url_setting}>
                    <ToggleSwitch checked={embedConnectorInfo} size="small" onClick={toggleConnectorEmbedding} />
                    <div className={styles.sharing_url_setting_name}>Embed non-sensitive connector info</div>
                </div>
            </Box>
        </AnchoredOverlay>
    );
};
