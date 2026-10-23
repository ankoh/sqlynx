import * as React from 'react';
import * as styles from './session_file_save_overlay.module.css';

import { DownloadIcon, FileIcon } from '../../../ui/foundations/symbol_icon.js';

import { AnchorAlignment } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { ConnectionState } from '../../connections/connection_state.js';
import { SessionExportSettings, SessionExportSettingsView } from './session_export_settings_view.js';
import { SessionScripts } from '../scripts/session_scripts.js';
import { classNames } from '../../../utils/classnames.js';
import { exportSessionAsSharedZip } from '../persistence/session_export.js';
import { connectionParamsHaveLoginHint, getConnectionParamsFromStateDetails } from '../../connections/connection_params.js';
import { formatBytes } from '../../../utils/format.js';
import { useFileDownloader } from '../../../platform/file/file_downloader_hook.js';
import { useStorageReader } from '../../storage/storage_provider.js';
import { StorageBackend } from '../../storage/storage_backend.js';
import { IconButton } from '../../../ui/foundations/button.js';
import { DASHQL_ARCHIVE_FILENAME_EXT } from '../../../globals.js';
import { resolveSessionConnections, useConnectionReferences, useConnectionRegistry } from '../../connections/connection_registry.js';

async function packAndCompressFile(
    backend: StorageBackend,
    databases: ConnectionState[],
    sessionScripts: SessionScripts,
    settings: SessionExportSettings,
): Promise<Uint8Array> {
    const connectionParams = new Map();
    for (const database of databases) {
        const params = database.params;
        if (params != null) connectionParams.set(database.connectionId, params);
    }
    const zipBlob = await exportSessionAsSharedZip(backend, sessionScripts.sessionId, connectionParams, settings);
    const arrayBuffer = await zipBlob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
}

interface Props {
    className?: string;
    isOpen: boolean;
    setIsOpen: (v: boolean) => void;
    anchorRef?: React.RefObject<HTMLButtonElement | null>;
    sessionScripts: SessionScripts | null;
    conn: ConnectionState | null;
    fileName?: string;
}

export const SessionFileSaveOverlay: React.FC<Props> = (props: Props) => {
    const anchorRef = React.createRef<HTMLDivElement>();
    const buttonRef = React.createRef<HTMLButtonElement>();
    const fileDownloader = useFileDownloader();
    const storage = useStorageReader();
    const [databaseRegistry] = useConnectionRegistry();
    const references = useConnectionReferences();
    const fileName = `${props.fileName ?? props.sessionScripts?.sessionMetadata.originalFileName ?? "session"}.${DASHQL_ARCHIVE_FILENAME_EXT}`;

    const [settings, setSettings] = React.useState<SessionExportSettings>({
        withCatalog: true,
        withLoginHint: true,
        preserveUUIDs: false,
    });

    const [fileBytes, setFileBytes] = React.useState<Uint8Array>(new Uint8Array());
    React.useEffect(() => {
        if (!props.isOpen) {
            return;
        }
        const conn = props.conn;
        const sessionScripts = props.sessionScripts;
        if (conn == null || sessionScripts == null) {
            return;
        }
        const cancellation = new AbortController();
        setFileBytes(new Uint8Array());
        const pack = async () => {
            const attached = resolveSessionConnections(databaseRegistry, references, sessionScripts.sessionId);
            if (attached == null) return;
            const fileBytes = await packAndCompressFile(
                storage.backend,
                [attached.main, ...attached.attached],
                sessionScripts,
                settings,
            );
            if (!cancellation.signal.aborted) {
                setFileBytes(fileBytes);
            }
        };
        pack().catch(() => {
            if (!cancellation.signal.aborted) setFileBytes(new Uint8Array());
        });
        return () => cancellation.abort();
    }, [databaseRegistry, references, settings, props.conn, props.sessionScripts, props.isOpen, storage.backend]);

    const hasLoginHint = React.useMemo(
        () => props.conn != null && connectionParamsHaveLoginHint(getConnectionParamsFromStateDetails(props.conn.details)),
        [props.conn],
    );

    const downloadFile = React.useCallback(async () => {
        await fileDownloader.downloadBufferAsFile(fileBytes, fileName);
    }, [fileBytes, fileName]);

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
            <div className={classNames(styles.overlay, props.className)}>
                <div className={styles.header}>
                    <div className={styles.file_icon_container}>
                        <FileIcon />
                    </div>
                    <div className={styles.file_info}>
                        <div className={styles.file_name}>{fileName}</div>
                        <div className={styles.file_size}>~&nbsp;{formatBytes(fileBytes.length)}</div>
                    </div>
                    <div className={styles.download}>
                        <IconButton
                            ref={buttonRef}
                            onClick={downloadFile}
                            disabled={fileBytes.length === 0}
                            aria-labelledby="save-file"
                            aria-label="Save File"
                        >
                            <DownloadIcon />
                        </IconButton>
                    </div>
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
