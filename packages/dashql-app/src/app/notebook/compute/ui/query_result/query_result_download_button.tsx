import * as arrow from 'apache-arrow';
import * as React from 'react';

import { QueryExecutionStatus, type QueryExecutionState } from '../../../connections/query_execution_state.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../../../ui/foundations/button.js';
import { DownloadIcon } from '../../../../../ui/foundations/symbol_icon.js';
import { useFileDownloader } from '../../../../../platform/file/file_downloader_provider.js';
import { useLogger } from '../../../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../../../platform/logger/logger.js';

interface Props {
    query: QueryExecutionState;
    dependencies?: {
        useFileDownloader: () => Pick<ReturnType<typeof useFileDownloader>, 'downloadBufferAsFile'>;
        useLogger: () => Pick<ReturnType<typeof useLogger>, 'error'>;
    };
}

export function QueryResultDownloadButton({ query, dependencies = { useFileDownloader, useLogger } }: Props) {
    const fileDownloader = dependencies.useFileDownloader();
    const logger = dependencies.useLogger();
    const [downloading, setDownloading] = React.useState(false);

    const downloadResult = async () => {
        if (query.status !== QueryExecutionStatus.SUCCEEDED || query.resultTable == null || downloading) return;
        setDownloading(true);
        try {
            const bytes = arrow.tableToIPC(query.resultTable, 'file');
            await fileDownloader.downloadBufferAsFile(bytes, `query-result-${query.queryId}.arrow`);
        } catch (error) {
            logger.error('Failed to download query result', { error: stringifyError(error) }, 'query_result_download');
        } finally {
            setDownloading(false);
        }
    };

    return (
        <IconButton
            variant={ButtonVariant.Invisible}
            size={ButtonSize.Small}
            aria-label="Download query result as Arrow file"
            onClick={downloadResult}
            disabled={query.status !== QueryExecutionStatus.SUCCEEDED || query.resultTable == null || downloading}
        >
            <DownloadIcon size={16} />
        </IconButton>
    );
}
