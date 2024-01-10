import React from 'react';
import LZString from 'lz-string';

import { TextInput, AnchoredOverlay, Box, IconButton } from '@primer/react';
import { PaperclipIcon } from '@primer/octicons-react';

import { sleep } from '../../utils/sleep';
import { ScriptData, ScriptKey, ScriptState } from '../../scripts/script_state';
import { useScriptState } from '../../scripts/script_state_provider';

import styles from './script_url_overlay.module.css';
import classNames from 'classnames';

const encodeScript = (url: URL, prefix: string, data: ScriptData) => {
    if (data.script) {
        const text = data.script.toString();
        const textBase64 = LZString.compressToBase64(text);
        url.searchParams.set(`${prefix}-script`, encodeURIComponent(textBase64));
    }
};

const buildURL = (state: ScriptState | null = null): URL => {
    const baseURL = process.env.SQLYNX_APP_URL;
    const urlText = baseURL ?? '';
    const url = new URL(urlText);
    const mainScript = state?.scripts[ScriptKey.MAIN_SCRIPT] ?? null;
    const schemaScript = state?.scripts[ScriptKey.SCHEMA_SCRIPT] ?? null;
    if (mainScript?.script) {
        encodeScript(url, 'main', mainScript);
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
    onClose: () => void;
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
    const [url, urlText] = React.useMemo(() => {
        const url = buildURL(scriptState);
        const urlText = url.toString();
        return [url, urlText];
    }, [scriptState.scripts[ScriptKey.MAIN_SCRIPT], scriptState.scripts[ScriptKey.SCHEMA_SCRIPT]]);

    // Copy the url to the clipboard
    React.useCallback(
        (url: URL) => {
            const urlText = url.toString();
            setState(s => ({
                ...s,
                copyStartedAt: new Date(),
                copyFinishedAt: null,
                copyError: null,
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
                await sleep(5000);
                setState(s => ({
                    ...s,
                    uiResetAt: new Date(),
                }));
            };
            copy();
        },
        [setState],
    );

    const anchorRef = React.createRef<HTMLDivElement>();
    return (
        <AnchoredOverlay
            renderAnchor={() => <div ref={anchorRef} />}
            open={props.isOpen}
            onClose={props.onClose}
            anchorRef={anchorRef}
            align="end"
        >
            <Box className={classNames(styles.sharing_overlay, props.className)}>
                <div className={styles.sharing_title}>Save Query as Link</div>
                <TextInput className={styles.sharing_url} disabled={true} value={urlText} />
                <IconButton
                    className={styles.sharing_button}
                    icon={PaperclipIcon}
                    aria-labelledby="copy-to-clipboard"
                />
            </Box>
        </AnchoredOverlay>
    );
};
