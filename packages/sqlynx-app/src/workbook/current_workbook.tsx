import * as React from 'react';

import { Dispatch } from '../utils/variant.js';
import { WorkbookState } from './workbook_state.js';
import { ModifyWorkbook, useWorkbookState } from './workbook_state_registry.js';

type CurrentWorkbookSetter = Dispatch<React.SetStateAction<number | null>>;

const WORKBOOK_CTX = React.createContext<[number | null, CurrentWorkbookSetter] | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const CurrentWorkbookStateProvider: React.FC<Props> = (props: Props) => {
    const active = React.useState<number | null>(null);
    return (
        <WORKBOOK_CTX.Provider value={active}>
            {props.children}
        </WORKBOOK_CTX.Provider>
    );
};

export function useCurrentWorkbookSelector(): CurrentWorkbookSetter {
    const [_currentWorkbook, setCurrentWorkbook] = React.useContext(WORKBOOK_CTX)!;
    return setCurrentWorkbook;
}

export function useCurrentWorkbookState(): [WorkbookState | null, ModifyWorkbook] {
    const [currentWorkbook, _setCurrentWorkbook] = React.useContext(WORKBOOK_CTX)!;
    return useWorkbookState(currentWorkbook);
}
