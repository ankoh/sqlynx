import * as React from 'react';
import * as styles from './workbook_url_share_overlay.module.css';

import { Box, IconButton } from '@primer/react';
import { CheckIcon, PaperclipIcon } from '@primer/octicons-react';

import { AnchorAlignment } from '../foundations/anchored_position.js';
import { AnchoredOverlay } from '../foundations/anchored_overlay.js';
import { TextInput } from '../foundations/text_input.js';
import { classNames } from '../../utils/classnames.js';
import { encodeWorkbookAsProto, encodeWorkbookProtoAsUrl, WorkbookLinkTarget } from '../../workbook/workbook_export_url.js';
import { getConnectionParamsFromDetails } from '../../connection/connection_params.js';
import { sleep } from '../../utils/sleep.js';
import { useConnectionState } from '../../connection/connection_registry.js';
import { useCurrentWorkbookState } from '../../workbook/current_workbook.js';
import { WorkbookExportSettingsView } from './workbook_export_settings_view.js';
import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';

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

export const WorkbookURLShareOverlay: React.FC<Props> = (props: Props) => {
    const anchorRef = React.createRef<HTMLDivElement>();
    const buttonRef = React.createRef<HTMLAnchorElement>();

    const [workbookState, _modifyWorkbook] = useCurrentWorkbookState();
    const [connectionState, _setConnectionState] = useConnectionState(workbookState?.connectionId ?? null);
    const [state, setState] = React.useState<State>(() => ({
        publicURLText: null,
        copyStartedAt: null,
        copyFinishedAt: null,
        copyError: null,
        uiResetAt: null,
    }));
    const [settings, setSettings] = React.useState<WorkbookExportSettings>({
        exportCatalog: false,
        exportUsername: true
    });

    React.useEffect(() => {
        let setupUrl: URL | null = null;
        if (workbookState != null && connectionState != null) {
            const params = getConnectionParamsFromDetails(connectionState.details);
            if (params != null) {
                const proto = encodeWorkbookAsProto(workbookState, params, settings);
                setupUrl = encodeWorkbookProtoAsUrl(proto, WorkbookLinkTarget.WEB);
            }
        }
        setState({
            publicURLText: setupUrl?.toString() ?? null,
            copyStartedAt: null,
            copyFinishedAt: null,
            copyError: null,
            uiResetAt: null,
        });
    }, [settings, workbookState, connectionState]);

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

    return (
        <AnchoredOverlay
            renderAnchor={() => <div ref={anchorRef} />}
            open={props.isOpen}
            onClose={() => props.setIsOpen(false)}
            anchorRef={anchorRef}
            align={AnchorAlignment.End}
            overlayProps={{
                initialFocusRef: buttonRef,
            }}
        >
            <Box className={classNames(styles.sharing_overlay, props.className)}>
                <div className={styles.sharing_url}>
                    <TextInput disabled={true} value={state.publicURLText ?? ''} />
                    <IconButton
                        ref={buttonRef}
                        icon={state.copyFinishedAt != null && state.uiResetAt == null ? CheckIcon : PaperclipIcon}
                        onClick={copyURL}
                        aria-labelledby="copy-to-clipboard"
                    />
                    <div className={styles.sharing_url_stats}>{state.publicURLText?.length ?? 0} characters</div>
                </div>
                <WorkbookExportSettingsView
                    withCatalog={false}
                    settings={settings}
                    setSettings={setSettings}
                />
            </Box>
        </AnchoredOverlay>
    );
};
