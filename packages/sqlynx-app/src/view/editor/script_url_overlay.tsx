import React from 'react';
import LZString from 'lz-string';
import classNames from 'classnames';

import { TextInput, AnchoredOverlay, Box, IconButton } from '@primer/react';
import { CheckIcon, PaperclipIcon } from '@primer/octicons-react';

import { sleep } from '../../utils/sleep';
import { ScriptData, ScriptKey, ScriptState } from '../../scripts/script_state';
import { useScriptState } from '../../scripts/script_state_provider';

import styles from './script_url_overlay.module.css';

const COPY_CHECKMARK_DURATION_MS = 1000;

const encodeScript = (url: URL, key: string, data: ScriptData) => {
    if (data.script) {
        const text = data.script.toString();
        const textBase64 = LZString.compressToBase64(text);
        url.searchParams.set(key, encodeURIComponent(textBase64));
    }
};

const buildURL = (state: ScriptState | null = null): URL => {
    const baseURL = process.env.SQLYNX_APP_URL;
    const urlText = baseURL ?? '';
    const url = new URL(urlText);
    const mainScript = state?.scripts[ScriptKey.MAIN_SCRIPT] ?? null;
    const schemaScript = state?.scripts[ScriptKey.SCHEMA_SCRIPT] ?? null;
    if (mainScript?.script) {
        encodeScript(url, 'script', mainScript);
    }
    if (schemaScript?.script) {
        encodeScript(url, 'schema', schemaScript);
    }
    return url;
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
    const scriptState = useScriptState();
    const [state, setState] = React.useState<State>(() => ({
        url: null,
        urlText: null,
        copyStartedAt: null,
        copyFinishedAt: null,
        copyError: null,
        uiResetAt: null,
    }));
    React.useEffect(() => {
        const url = buildURL(scriptState);
        const urlText = url.toString();
        setState({
            url,
            urlText,
            copyStartedAt: null,
            copyFinishedAt: null,
            copyError: null,
            uiResetAt: null,
        });
    }, [scriptState.scripts[ScriptKey.MAIN_SCRIPT], scriptState.scripts[ScriptKey.SCHEMA_SCRIPT]]);

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
                </div>
            </Box>
        </AnchoredOverlay>
    );
};
