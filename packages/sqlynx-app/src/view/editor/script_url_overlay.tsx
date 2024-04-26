import * as React from 'react';

import { TextInput, AnchoredOverlay, Box, IconButton } from '@primer/react';
import { CheckIcon, PaperclipIcon } from '@primer/octicons-react';

import { classNames } from '../../utils/classnames.js';
import { sleep } from '../../utils/sleep.js';
import { useActiveSessionState } from '../../session/active_session.js';
import { useConnectionState } from '../../connectors/connection_registry.js';
import { SessionLinkTarget, generateSessionSetupUrl } from '../../session/session_setup_url.js';

import * as styles from './script_url_overlay.module.css';

const COPY_CHECKMARK_DURATION_MS = 1000;

interface Props {
    className?: string;
    isOpen: boolean;
    setIsOpen: (v: boolean) => void;
}

interface State {
    publicURLText: string | null;
    copyStartedAt: Date | null;
    copyFinishedAt: Date | null;
    copyError: any | null;
    uiResetAt: Date | null;
}

export const ScriptURLOverlay: React.FC<Props> = (props: Props) => {
    const [sessionState, _modifySessionState] = useActiveSessionState();
    const [connectionState, _setConnectionState] = useConnectionState(sessionState?.connectionId ?? null);
    const [state, setState] = React.useState<State>(() => ({
        publicURLText: null,
        copyStartedAt: null,
        copyFinishedAt: null,
        copyError: null,
        uiResetAt: null,
    }));

    React.useEffect(() => {
        let setupUrl: URL | null = null;
        if (sessionState != null && connectionState != null) {
            setupUrl = generateSessionSetupUrl(sessionState, connectionState, SessionLinkTarget.WEB);
        }
        setState({
            publicURLText: setupUrl?.toString() ?? null,
            copyStartedAt: null,
            copyFinishedAt: null,
            copyError: null,
            uiResetAt: null,
        });
    }, [sessionState, connectionState]);

    // Copy the url to the clipboard
    const copyURL = React.useCallback(
        (event: React.MouseEvent) => {
            if (!state.publicURLText) return;
            event.stopPropagation();
            const urlText = state.publicURLText;
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
