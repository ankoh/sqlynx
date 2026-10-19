import * as arrow from 'apache-arrow';
import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QueryExecutionStatus } from '../../connections/query_execution_state.js';
import { QueryResultDownloadButton } from '../../compute/ui/query_result/query_result_download_button.js';
import { FeedEntryFooter, type FeedEntryFooterDependencies } from './feed_entry_footer.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const download = vi.fn();
const onShowTable = vi.fn();
const dependencies = {
    useResultRowCount: () => ({ hasResult: true, totalRows: 3 }),
    useQueryResultRowCounts: () => ({ totalRows: 3, currentRows: 3, matchingRows: null }),
    QueryResultToolbar: () => null,
    QueryResultView: () => <div data-testid="feed-preview" />,
    QueryResultDownloadButton: props => <QueryResultDownloadButton {...props} dependencies={{
        useFileDownloader: () => ({ downloadBufferAsFile: download }),
        useLogger: () => ({ error: vi.fn() }),
    }} />,
} as FeedEntryFooterDependencies;

describe('FeedEntryFooter', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        download.mockReset().mockResolvedValue(undefined);
        onShowTable.mockReset();
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('downloads the full original result from the feed header without opening Details', async () => {
        const resultTable = arrow.tableFromArrays({ value: [10, 20, 30] });
        act(() => root.render(
            <FeedEntryFooter
                notebookId="notebook"
                queryState={{ queryId: 42, traceId: 9, status: QueryExecutionStatus.SUCCEEDED, resultTable } as any}
                visualizeQuery={null}
                onShowTable={onShowTable}
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector('[data-testid="feed-preview"]')).not.toBeNull();
        const header = Array.from(container.querySelectorAll<HTMLDivElement>('div'))
            .find(element => element.querySelector(':scope > button')?.textContent?.includes('Query Results'))!;
        const button = header.querySelector<HTMLButtonElement>('button[aria-label="Download query result as Arrow file"]')!;
        expect(button).not.toBeNull();
        expect(button.disabled).toBe(false);
        await act(async () => button.click());

        expect(onShowTable).not.toHaveBeenCalled();
        expect(download).toHaveBeenCalledTimes(1);
        const [bytes, filename] = download.mock.calls[0];
        expect(filename).toBe('query-result-42.arrow');
        expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('ARROW1');
        const exported = arrow.tableFromIPC(bytes);
        expect(exported.schema.fields.map(field => field.name)).toEqual(['value']);
        expect(Array.from(exported.getChild('value')!)).toEqual([10, 20, 30]);
    });
});
