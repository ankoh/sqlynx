import React from 'react';
import LZString from 'lz-string';

import { FormControl, TextInput, AnchoredOverlay, Box, Button, IconButton } from '@primer/react';
import { PaperclipIcon } from '@primer/octicons-react';

import * as utils from '../../utils';
import { sleep } from '../../utils/sleep';
import { estimateUTF16Length } from '../../utils/text';
import { ScriptData, ScriptKey, ScriptState } from '../../scripts/script_state';

import styles from './script_url_overlay.module.css';

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
    const [state, setState] = React.useState<State>(() => ({
        url: null,
        urlText: null,
        copyStartedAt: null,
        copyFinishedAt: null,
        copyError: null,
        uiResetAt: null,
    }));

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
        <AnchoredOverlay renderAnchor={() => <div ref={anchorRef} />} open={props.isOpen} anchorRef={anchorRef}>
            <Box className={styles.sharing_overlay} padding={2}>
                <FormControl>
                    <TextInput className={styles.url_text} disabled={true} />
                    <FormControl.Caption id="url-text">
                        {state.urlText == null
                            ? 'url is empty'
                            : `~&nbsp;${utils.formatBytes(estimateUTF16Length(state.urlText))}`}
                    </FormControl.Caption>
                </FormControl>
                <IconButton className={styles.copy_icon} icon={PaperclipIcon} aria-labelledby="copy-to-clipboard" />
            </Box>
        </AnchoredOverlay>
    );
};
