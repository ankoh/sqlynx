import * as React from 'react';

import * as styles from './session_url_share_overlay.module.css';

import { CheckIcon, PaperclipIcon } from '../../../ui/foundations/symbol_icon.js';

import { AnchorAlignment } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { IconButton } from '../../../ui/foundations/button.js';
import { TextInput } from '../../../ui/foundations/text_input.js';
import { SessionExportSettings, SessionExportSettingsView } from './session_export_settings_view.js';
import { classNames } from '../../../utils/classnames.js';
import { exportSessionAsUrl, SessionLinkTarget } from '../persistence/session_export.js';
import { connectionParamsHaveLoginHint, getConnectionParamsFromStateDetails } from '../../connections/connection_params.js';
import { sleep } from '../../../utils/sleep.js';
import { resolveSessionAttachedDatabases, useConnectionState, useConnectionRegistry } from '../../connections/connection_registry.js';
import { useRouteContext } from '../../router/router.js';
import { useSessionScripts } from '../scripts/session_scripts_registry.js';
import { useStorageReader } from '../../storage/storage_provider.js';

const COPY_CHECKMARK_DURATION_MS = 1000;

interface Props {
    className?: string;
    isOpen: boolean;
    sessionId?: string;
    setIsOpen: (v: boolean) => void;
    anchorRef?: React.RefObject<HTMLButtonElement | null>;
}

interface State {
    publicURLText: string | null;
    copyStartedAt: Date | null;
    copyFinishedAt: Date | null;
    copyError: any | null;
    uiResetAt: Date | null;
}

export const SessionURLShareOverlay: React.FC<Props> = (props: Props) => {
    const route = useRouteContext();
    const anchorRef = React.createRef<HTMLDivElement>();
    const buttonRef = React.createRef<HTMLButtonElement>();

    const [sessionScripts] = useSessionScripts(props.sessionId ?? route.sessionId ?? null);
    const [connection, _modifyConnection] = useConnectionState(sessionScripts?.sessionId ?? null);
    const [databaseRegistry] = useConnectionRegistry();
    const storage = useStorageReader();
    const [state, setState] = React.useState<State>(() => ({
        publicURLText: null,
        copyStartedAt: null,
        copyFinishedAt: null,
        copyError: null,
        uiResetAt: null,
    }));
    const [settings, setSettings] = React.useState<SessionExportSettings>({
        withCatalog: false,
        withLoginHint: true,
        preserveUUIDs: false,
    });

    React.useEffect(() => {
        if (!props.isOpen) {
            return;
        }

        let cancelled = false;
        setState(s => ({ ...s, publicURLText: null, copyError: null }));

        async function generateURL() {
            let setupUrl: URL | null = null;
            if (sessionScripts != null && connection != null) {
                const attached = resolveSessionAttachedDatabases(databaseRegistry, sessionScripts.sessionId);
                if (attached != null) {
                    const params = new Map();
                    for (const database of [attached.main, ...attached.attached]) {
                        const connectionParams = database.params;
                        if (connectionParams != null) params.set(database.connectionId, connectionParams);
                    }
                    setupUrl = await exportSessionAsUrl(
                        storage.backend,
                        sessionScripts.sessionId,
                        params,
                        SessionLinkTarget.WEB,
                        settings,
                    );
                }
            }

            if (!cancelled) {
                setState({
                    publicURLText: setupUrl?.toString() ?? null,
                    copyStartedAt: null,
                    copyFinishedAt: null,
                    copyError: null,
                    uiResetAt: null,
                });
            }
        }

        generateURL().catch(error => {
            if (!cancelled) setState(s => ({ ...s, publicURLText: null, copyError: error }));
        });

        return () => {
            cancelled = true;
        };
    }, [databaseRegistry, settings, sessionScripts, connection, props.isOpen]);

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

    const hasLoginHint = React.useMemo(
        () => connection != null && connectionParamsHaveLoginHint(getConnectionParamsFromStateDetails(connection.details)),
        [connection],
    );

    const ButtonIcon = state.copyFinishedAt != null && state.uiResetAt == null ? CheckIcon : PaperclipIcon;
    return (
        <AnchoredOverlay
            renderAnchor={props.anchorRef ? null : () => <div ref={anchorRef} />}
            open={props.isOpen}
            onClose={() => props.setIsOpen(false)}
            anchorRef={props.anchorRef ?? anchorRef}
            returnFocusRef={props.anchorRef}
            align={AnchorAlignment.End}
            overlayProps={{
                initialFocusRef: buttonRef,
            }}
        >
            <div className={classNames(styles.sharing_overlay, props.className)}>
                <div className={styles.sharing_url}>
                    <TextInput disabled={true} aria-label="Session share URL" value={state.publicURLText ?? ''} />
                    <IconButton
                        ref={buttonRef}
                        onClick={copyURL}
                        disabled={state.publicURLText == null}
                        aria-labelledby="copy-to-clipboard"
                        aria-label="Copy to Clipboard"
                    >
                        <ButtonIcon />
                    </IconButton>
                    <div className={styles.sharing_url_stats}>{state.publicURLText?.length ?? 0} characters</div>
                </div>
                <SessionExportSettingsView
                    withCatalog={true}
                    withLoginHint={hasLoginHint}
                    settings={settings}
                    setSettings={setSettings}
                />
            </div>
        </AnchoredOverlay>
    );
};
