import * as React from 'react';

import { type JsonViewProps } from './json_view.js';
import { ToolVisibilityStore, ToolVisibilityStateProvider } from './json_tool_state.js';
import { useNestedExpansionReducer, NestedExpansionStateProvider } from './json_nested_state.js';

export interface JsonViewerState {
    value?: object;
    onExpand?: JsonViewProps['onExpand'];
    onCopied?: JsonViewProps['onCopied'];
    beforeCopy?: JsonViewProps['beforeCopy'];
    objectSortKeys?: JsonViewProps['objectSortKeys'];
    displayObjectSize?: JsonViewProps['displayObjectSize'];
    shortenTextAfterLength?: JsonViewProps['shortenTextAfterLength'];
    stringEllipsis?: JsonViewProps['stringEllipsis'];
    enableClipboard?: JsonViewProps['enableClipboard'];
    highlightUpdates?: JsonViewProps['highlightUpdates'];
    collapsed?: JsonViewProps['collapsed'];
    shouldExpandNodeInitially?: JsonViewProps['shouldExpandNodeInitially'];
    indentWidth?: number;
    arrayPageSize?: number;
}

export const initialState: JsonViewerState = {
    objectSortKeys: false,
    indentWidth: 15,
};

export const Context = React.createContext<JsonViewerState>(initialState);

export const useJsonViewerState = () => {
    return React.useContext(Context);
};

export interface JsonViewerStateProps {
    initialState?: JsonViewerState;
}

export const JsonViewerStateProvider = ({
    children,
    initialState: init,
}: React.PropsWithChildren<JsonViewerStateProps>) => {
    // The JsonView memoizes the state, so this only changes when one of its props changes
    const state = React.useMemo(() => Object.assign({}, initialState, init), [init]);
    const [toolStore] = React.useState(() => new ToolVisibilityStore());
    const [expands, expandsDispatch] = useNestedExpansionReducer();
    return (
        <Context.Provider value={state}>
            <ToolVisibilityStateProvider store={toolStore}>
                <NestedExpansionStateProvider initial={expands} dispatch={expandsDispatch}>
                    {children}
                </NestedExpansionStateProvider>
            </ToolVisibilityStateProvider>
        </Context.Provider>
    );
};
