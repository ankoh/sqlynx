import * as React from 'react';
import * as styles from './session_feed.module.css';
import type { ConnectionState } from '../../../connections/connection_state.js';
import { HYPER_CONNECTOR } from '../../../connections/connector_info.js';
import type { DataFile } from '../../../storage/storage_backend.js';
import type { StorageReader } from '../../../storage/storage_provider.js';
import { useFileDownloader } from '../../../../platform/file/file_downloader_hook.js';
import { useLogger } from '../../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../../platform/logger/logger.js';
import { CopyToClipboardButton } from '../../../../utils/clipboard.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { DownloadIcon, FileIcon, TrashIcon } from '../../../../ui/foundations/symbol_icon.js';
import { formatBytes } from '../../../../utils/format.js';

export interface SessionDataCardProps {
    sessionId: string;
    file: DataFile;
    conn: ConnectionState | null;
    storageReader: StorageReader;
    onRemoved: () => void;
}

export const SessionDataCard: React.FC<SessionDataCardProps> = (props) => {
    const downloader = useFileDownloader();
    const logger = useLogger();
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const enabled = props.conn?.details.type === HYPER_CONNECTOR
        && props.conn.details.value.proto.setupParams?.protocol === 'WASM';
    const disabled = !enabled || busy;
    const path = `/mnt/fs/sessions/${props.sessionId}/attachments/${props.file.name}`;
    const extension = props.file.name.split('.').pop()?.toUpperCase() ?? 'FILE';

    const download = async () => {
        if (disabled) return;
        setBusy(true);
        setError(null);
        try {
            const bytes = await props.storageReader.backend.loadDataFile(props.sessionId, props.file.name);
            await downloader.downloadBufferAsFile(bytes, props.file.name);
        } catch (e) {
            setError('Downloading data file failed');
            logger.error('Downloading data file failed', { error: stringifyError(e) }, 'session_data_card');
        } finally {
            setBusy(false);
        }
    };
    const remove = async () => {
        if (disabled) return;
        setBusy(true);
        setError(null);
        try {
            await props.storageReader.backend.deleteDataFile(props.sessionId, props.file.name);
            props.onRemoved();
        } catch (e) {
            setError('Removing data file failed');
            logger.error('Removing data file failed', { error: stringifyError(e) }, 'session_data_card');
        } finally {
            setBusy(false);
        }
    };

    return (
        <article className={styles.feed_data_card} aria-label={`${props.file.name} attachment`} data-electron-drag-region="false">
            <div className={styles.feed_data_card_topline}>
                <div className={styles.feed_data_file_icon} aria-hidden="true">
                    <FileIcon size={24} />
                    <span>{extension}</span>
                </div>
                <div className={styles.feed_data_title}>
                    <span className={styles.feed_data_name}>{props.file.name}</span>
                    <span className={styles.feed_data_size}>{formatBytes(props.file.sizeBytes)}</span>
                </div>
                <div className={styles.feed_data_actions}>
                    <CopyToClipboardButton variant={ButtonVariant.Invisible} size={ButtonSize.Medium}
                        value={path} logContext="session_data_card" disabled={disabled}
                        aria-label={`Copy HyperDB path for ${props.file.name}`} aria-labelledby="" />
                    <IconButton variant={ButtonVariant.Invisible} size={ButtonSize.Medium}
                        disabled={disabled} onClick={download} aria-label={`Download ${props.file.name}`}>
                        <DownloadIcon size={16} />
                    </IconButton>
                    <IconButton variant={ButtonVariant.Invisible} size={ButtonSize.Medium}
                        disabled={disabled} onClick={remove} aria-label={`Remove ${props.file.name}`}>
                        <TrashIcon size={16} />
                    </IconButton>
                </div>
            </div>
            {error != null && <div role="alert">{error}</div>}
        </article>
    );
};
