import * as React from 'react';

import * as styles from './notebook_url_share_overlay.module.css';

import { CheckIcon, PaperclipIcon } from '../../../ui/foundations/symbol_icon.js';

import { AnchorAlignment } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { IconButton } from '../../../ui/foundations/button.js';
import { TextInput } from '../../../ui/foundations/text_input.js';
import { NotebookExportSettings, NotebookExportSettingsView } from './notebook_export_settings_view.js';
import { classNames } from '../../../utils/classnames.js';
import { exportNotebookAsUrl, NotebookLinkTarget } from '../persistence/notebook_export.js';
import { connectionParamsHaveLoginHint, getConnectionParamsFromStateDetails } from '../connections/connection_params.js';
import { sleep } from '../../../utils/sleep.js';
import { resolveNotebookAttachedDatabases, useAttachedDatabaseState, useAttachedDatabaseRegistry } from '../connections/attached_database_registry.js';
import { useRouteContext } from '../../router/router.js';
import { useNotebookScripts } from '../scripts/notebook_scripts_registry.js';
import { useStorageReader } from '../persistence/storage_provider.js';

const COPY_CHECKMARK_DURATION_MS = 1000;

interface Props {
    className?: string;
    isOpen: boolean;
    notebookId?: string;
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

export const NotebookURLShareOverlay: React.FC<Props> = (props: Props) => {
    const route = useRouteContext();
    const anchorRef = React.createRef<HTMLDivElement>();
    const buttonRef = React.createRef<HTMLButtonElement>();

    const [notebookScripts] = useNotebookScripts(props.notebookId ?? route.notebookId ?? null);
    const [connection, _modifyConnection] = useAttachedDatabaseState(notebookScripts?.notebookId ?? null);
    const [databaseRegistry] = useAttachedDatabaseRegistry();
    const storage = useStorageReader();
    const [state, setState] = React.useState<State>(() => ({
        publicURLText: null,
        copyStartedAt: null,
        copyFinishedAt: null,
        copyError: null,
        uiResetAt: null,
    }));
    const [settings, setSettings] = React.useState<NotebookExportSettings>({
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
            if (notebookScripts != null && connection != null) {
                const attached = resolveNotebookAttachedDatabases(databaseRegistry, notebookScripts.notebookId);
                if (attached != null) {
                    const params = new Map();
                    for (const database of [attached.main, ...attached.attached]) {
                        const connectionParams = database.params;
                        if (connectionParams != null) params.set(database.databaseId, connectionParams);
                    }
                    setupUrl = await exportNotebookAsUrl(
                        storage.backend,
                        notebookScripts.notebookId,
                        params,
                        NotebookLinkTarget.WEB,
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
    }, [databaseRegistry, settings, notebookScripts, connection, props.isOpen]);

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
                    <TextInput disabled={true} aria-label="Notebook share URL" value={state.publicURLText ?? ''} />
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
                <NotebookExportSettingsView
                    withCatalog={true}
                    withLoginHint={hasLoginHint}
                    settings={settings}
                    setSettings={setSettings}
                />
            </div>
        </AnchoredOverlay>
    );
};
