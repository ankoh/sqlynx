import * as React from 'react';

import { AnchorAlignment, AnchorSide } from '../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../ui/foundations/anchored_overlay.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../ui/foundations/button.js';
import { OverlaySize } from '../../ui/foundations/overlay.js';
import { BeakerIcon, CheckIcon, CopyIcon, XIcon } from '../../ui/foundations/symbol_icon.js';
import {
    BUNDLED_SESSIONS,
    bundledSessionShareUrl,
    resolveBundledSessionUrl,
    type BundledSession,
} from '../session/persistence/bundled_sessions.js';
import { usePlatformEventListener } from '../../platform/events/event_listener_provider.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import * as styles from './bundled_sessions_overlay.module.css';

export interface BundledSessionsOverlayProps {
    side?: AnchorSide;
    align?: AnchorAlignment;
    triggerSize?: ButtonSize;
    triggerIconSize?: number;
    dispatchSessionUrl?: (url: string) => void;
    dependencies?: BundledSessionsOverlayDependencies;
}

export interface BundledSessionsOverlayDependencies {
    useLogger: () => Pick<ReturnType<typeof useLogger>, 'error'>;
}

const DEFAULT_DEPENDENCIES: BundledSessionsOverlayDependencies = {
    useLogger,
};

export function BundledSessionsOverlay(props: BundledSessionsOverlayProps = {}): React.ReactElement {
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const appEvents = usePlatformEventListener();
    const logger = dependencies.useLogger();
    const anchorRef = React.useRef<HTMLButtonElement>(null);
    const [open, setOpen] = React.useState(false);
    const [copiedId, setCopiedId] = React.useState<string | null>(null);
    const titleId = React.useId();

    const copySessionLink = React.useCallback(async (session: BundledSession) => {
        try {
            await navigator.clipboard.writeText(bundledSessionShareUrl(session));
            setCopiedId(session.id);
        } catch (error) {
            logger.error('failed to copy bundled session link', { error: String(error) }, 'session_selector');
        }
    }, [logger]);

    const addSession = React.useCallback((session: BundledSession) => {
        setOpen(false);
        const url = resolveBundledSessionUrl(session, new URL(globalThis.location.href)).toString();
        (props.dispatchSessionUrl ?? appEvents.dispatchSessionUrl.bind(appEvents))(url);
    }, [appEvents, props.dispatchSessionUrl]);

    return (
        <>
            <IconButton
                ref={anchorRef}
                size={props.triggerSize}
                variant={open ? ButtonVariant.Default : ButtonVariant.Invisible}
                aria-label="Example sessions"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
            >
                <BeakerIcon size={props.triggerIconSize ?? 16} />
            </IconButton>
            <AnchoredOverlay
                renderAnchor={null}
                anchorRef={anchorRef}
                returnFocusRef={anchorRef}
                open={open}
                onClose={() => setOpen(false)}
                side={props.side ?? AnchorSide.OutsideTop}
                align={props.align ?? AnchorAlignment.Start}
                width={OverlaySize.S}
            >
                <section className={styles.overlay} role="dialog" aria-labelledby={titleId}>
                    <header>
                        <h2 id={titleId}>Example Sessions</h2>
                        <IconButton
                            aria-label="Close example sessions"
                            size={ButtonSize.Small}
                            variant={ButtonVariant.Invisible}
                            onClick={() => setOpen(false)}
                        >
                            <XIcon size={16} />
                        </IconButton>
                    </header>
                    <ul>
                        {BUNDLED_SESSIONS.map(session => {
                            const copied = copiedId === session.id;
                            return (
                                <li key={session.id}>
                                    <button
                                        className={styles.addButton}
                                        aria-label={`Add ${session.name} session`}
                                        onClick={() => addSession(session)}
                                    >
                                        {session.name}
                                    </button>
                                    <div className={styles.actions}>
                                        <IconButton
                                            aria-label={`Copy ${session.name} session link`}
                                            size={ButtonSize.Small}
                                            variant={ButtonVariant.Invisible}
                                            onClick={() => void copySessionLink(session)}
                                        >
                                            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                                        </IconButton>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                    <span className={styles.status} role="status" aria-live="polite">
                        {copiedId == null ? '' : `${BUNDLED_SESSIONS.find(session => session.id === copiedId)?.name} link copied`}
                    </span>
                </section>
            </AnchoredOverlay>
        </>
    );
}
