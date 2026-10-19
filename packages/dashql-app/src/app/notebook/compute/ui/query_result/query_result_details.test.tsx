import * as arrow from 'apache-arrow';
import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const mockState = {
    computationState: {
        tableComputations: {},
    } as any,
    dispatch: vi.fn(),
    download: vi.fn(),
    logError: vi.fn(),
};

import { MOST_FREQUENT_FILTER, CrossFilters } from '../../../../../compute/cross_filters.js';
import { SET_CROSS_FILTERS } from '../../../../../compute/computation_state.js';
import { QueryExecutionStatus } from '../../../connections/query_execution_state.js';
import { QueryResultDetails, type QueryResultDetailsDependencies } from './query_result_details.js';
import { QueryResultDownloadButton } from './query_result_download_button.js';

const dependencies = {
    QueryResultToolbar: () => null,
    QueryResultView: () => <div data-testid="query-result-view" />,
    useComputationRegistry: () => [mockState.computationState, mockState.dispatch],
    useQueryResultRowCounts: () => ({ totalRows: 3, currentRows: 3, matchingRows: null }),
    QueryResultDownloadButton: props => <QueryResultDownloadButton {...props} dependencies={{
        useFileDownloader: () => ({ downloadBufferAsFile: mockState.download }),
        useLogger: () => ({ error: mockState.logError }),
    }} />,
} as QueryResultDetailsDependencies;

describe('QueryResultDetails', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockState.dispatch.mockReset();
        mockState.download.mockReset().mockResolvedValue(undefined);
        mockState.logError.mockReset();
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('clears all active cross-filters from the query results bar', () => {
        const crossFilters = new CrossFilters();
        crossFilters.columnFilters[1] = {
            type: MOST_FREQUENT_FILTER,
            value: { valueId: 7, filters: [] },
        };
        mockState.computationState = {
            tableComputations: {
                42: {
                    dataTable: { numRows: 3 },
                    crossFilters,
                },
            },
        };

        act(() => root.render(
            <QueryResultDetails
                query={{ queryId: 42, status: QueryExecutionStatus.SUCCEEDED } as any}
                debugMode={false}
                actions={<button type="button">Close</button>}
                dependencies={dependencies}
            />,
        ));

        const clearButton = container.querySelector<HTMLButtonElement>('button[aria-label="Clear all cross-filters"]');
        expect(clearButton).not.toBeNull();
        expect(clearButton!.disabled).toBe(false);
        expect(container.textContent).toContain('Close');

        act(() => clearButton!.click());

        expect(mockState.dispatch).toHaveBeenCalledTimes(1);
        const action = mockState.dispatch.mock.calls[0][0];
        expect(action.type).toBe(SET_CROSS_FILTERS);
        expect(action.value[0]).toBe(42);
        expect(action.value[1]).toBeInstanceOf(CrossFilters);
        expect(action.value[1].columnFilters).toEqual({});
    });

    it('disables the clear action when no cross-filters are active', () => {
        mockState.computationState = {
            tableComputations: {
                42: {
                    dataTable: { numRows: 3 },
                    crossFilters: new CrossFilters(),
                },
            },
        };

        act(() => root.render(
            <QueryResultDetails
                query={{ queryId: 42, status: QueryExecutionStatus.SUCCEEDED } as any}
                debugMode={false}
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector<HTMLButtonElement>('button[aria-label="Clear all cross-filters"]')?.disabled).toBe(true);
    });

    it('downloads the complete original result as an Arrow IPC file without computed columns', async () => {
        const resultTable = arrow.tableFromArrays({ value: [10, 20, 30] });
        mockState.computationState = {
            tableComputations: {
                42: {
                    dataTable: arrow.tableFromArrays({ _rownum: [1, 2, 3], value: [10, 20, 30], _1_bin: [0, 1, 2] }),
                    crossFilters: new CrossFilters(),
                    filterTable: { dataTable: arrow.tableFromArrays({ _rownum: [2] }) },
                },
            },
        };
        act(() => root.render(
            <QueryResultDetails
                query={{ queryId: 42, status: QueryExecutionStatus.SUCCEEDED, resultTable } as any}
                debugMode={false}
                dependencies={dependencies}
            />,
        ));

        const button = container.querySelector<HTMLButtonElement>('button[aria-label="Download query result as Arrow file"]')!;
        expect(button.disabled).toBe(false);
        await act(async () => button.click());

        expect(mockState.download).toHaveBeenCalledTimes(1);
        const [bytes, filename] = mockState.download.mock.calls[0];
        expect(filename).toBe('query-result-42.arrow');
        expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('ARROW1');
        const exported = arrow.tableFromIPC(bytes);
        expect(exported.schema.fields.map(field => field.name)).toEqual(['value']);
        expect(Array.from(exported.getChild('value')!)).toEqual([10, 20, 30]);
    });

    it('disables download until a successful result table exists', () => {
        mockState.computationState = { tableComputations: {} };
        const render = (status: QueryExecutionStatus, resultTable: arrow.Table | null) => act(() => root.render(
            <QueryResultDetails
                query={{ queryId: 42, status, resultTable } as any}
                debugMode={false}
                dependencies={dependencies}
            />,
        ));
        const button = () => container.querySelector<HTMLButtonElement>('button[aria-label="Download query result as Arrow file"]')!;

        render(QueryExecutionStatus.RUNNING, arrow.tableFromArrays({ value: [1] }));
        expect(button().disabled).toBe(true);
        render(QueryExecutionStatus.SUCCEEDED, null);
        expect(button().disabled).toBe(true);
        expect(mockState.download).not.toHaveBeenCalled();
    });

    it('reports download failures and re-enables the action', async () => {
        mockState.computationState = { tableComputations: {} };
        mockState.download.mockRejectedValueOnce(new Error('Disk full'));
        act(() => root.render(
            <QueryResultDetails
                query={{ queryId: 42, status: QueryExecutionStatus.SUCCEEDED, resultTable: arrow.tableFromArrays({ value: [1] }) } as any}
                debugMode={false}
                dependencies={dependencies}
            />,
        ));

        const button = container.querySelector<HTMLButtonElement>('button[aria-label="Download query result as Arrow file"]')!;
        await act(async () => button.click());

        expect(mockState.logError).toHaveBeenCalledWith('Failed to download query result', { error: 'Disk full' }, 'query_result_download');
        await vi.waitFor(() => expect(button.disabled).toBe(false));
        await act(async () => button.click());
        expect(mockState.download).toHaveBeenCalledTimes(2);
    });
});
