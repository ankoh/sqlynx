import * as React from 'react';
import * as LZString from 'lz-string';

import { TextInput, AnchoredOverlay, Box, IconButton, ToggleSwitch } from '@primer/react';
import { CheckIcon, PaperclipIcon } from '@primer/octicons-react';

import { classNames } from '../../utils/classnames.js';
import { sleep } from '../../utils/sleep.js';
import { ScriptData } from '../../session/session_state.js';
import { useActiveSessionState } from '../../session/session_state_provider.js';
import { SessionURLs, useSessionURLs } from '../../session/session_url_manager.js';
import { useSalesforceAuthState } from '../../connectors/salesforce_auth_state.js';

import styles from './script_url_overlay.module.css';

const COPY_CHECKMARK_DURATION_MS = 1000;

interface Props {
    className?: string;
    isOpen: boolean;
    setIsOpen: (v: boolean) => void;
}

interface State {
    sessionURLs: SessionURLs | null;
    publicURLText: string | null;
    copyStartedAt: Date | null;
    copyFinishedAt: Date | null;
    copyError: any | null;
    uiResetAt: Date | null;
}

export const ScriptURLOverlay: React.FC<Props> = (props: Props) => {
    const [state, setState] = React.useState<State>(() => ({
        sessionURLs: null,
        publicURLText: null,
        copyStartedAt: null,
        copyFinishedAt: null,
        copyError: null,
        uiResetAt: null,
    }));
    const sessionURLs = useSessionURLs();

    React.useEffect(() => {
        setState({
            sessionURLs,
            publicURLText: sessionURLs?.publicLink.toString() ?? null,
            copyStartedAt: null,
            copyFinishedAt: null,
            copyError: null,
            uiResetAt: null,
        });
    }, [sessionURLs]);

    // Copy the url to the clipboard
    const copyURL = React.useCallback(
        (event: React.MouseEvent) => {
            if (!state.sessionURLs) return;
            event.stopPropagation();
            const urlText = state.sessionURLs.publicLink.toString();
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
                    <TextInput className={styles.sharing_url} disabled={true} value={state.publicURLText ?? ''} />
                    <IconButton
                        ref={buttonRef}
                        icon={state.copyFinishedAt != null && state.uiResetAt == null ? CheckIcon : PaperclipIcon}
                        onClick={copyURL}
                        aria-labelledby="copy-to-clipboard"
                    />
                    <div className={styles.sharing_url_stats}>{state.publicURLText?.length ?? 0} characters</div>
                </div>
            </Box>
        </AnchoredOverlay>
    );
};
