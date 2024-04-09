import * as React from 'react';

import { TextInput, AnchoredOverlay, Box, IconButton } from '@primer/react';
import { CheckIcon, PaperclipIcon } from '@primer/octicons-react';

import { classNames } from '../../utils/classnames.js';
import { sleep } from '../../utils/sleep.js';
import { SessionLinks, useSessionLinks } from '../../session/session_link_generator.js';

import * as styles from './script_url_overlay.module.css';

const COPY_CHECKMARK_DURATION_MS = 1000;

interface Props {
    className?: string;
    isOpen: boolean;
    setIsOpen: (v: boolean) => void;
}

interface State {
    sessionLinks: SessionLinks | null;
    publicURLText: string | null;
    copyStartedAt: Date | null;
    copyFinishedAt: Date | null;
    copyError: any | null;
    uiResetAt: Date | null;
}

export const ScriptURLOverlay: React.FC<Props> = (props: Props) => {
    const [state, setState] = React.useState<State>(() => ({
        sessionLinks: null,
        publicURLText: null,
        copyStartedAt: null,
        copyFinishedAt: null,
        copyError: null,
        uiResetAt: null,
    }));
    const sessionLinks = useSessionLinks();

    React.useEffect(() => {
        setState({
            sessionLinks: sessionLinks,
            publicURLText: sessionLinks?.publicWebLink.toString() ?? null,
            copyStartedAt: null,
            copyFinishedAt: null,
            copyError: null,
            uiResetAt: null,
        });
    }, [sessionLinks]);

    // Copy the url to the clipboard
    const copyURL = React.useCallback(
        (event: React.MouseEvent) => {
            if (!state.sessionLinks) return;
            event.stopPropagation();
            const urlText = state.sessionLinks.publicWebLink.toString();
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
