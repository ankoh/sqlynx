import * as React from 'react';

import { WorkbookState, DESTROY, WorkbookStateAction, reduceWorkbookState } from './workbook_state.js';
import { Dispatch } from '../utils/variant.js';

/// The workbook registry.
///
/// Note that we're deliberately not using immutable maps for workbooks and the connection index.
/// We're never "observing" these maps directly and thus can live with the simple variants.
/// Shallow-compare the entire registry object instead when reacting to workbook list changes.
interface WorkbookRegistry {
    /// The workbook map
    workbookMap: Map<number, WorkbookState>;
    /// The index to find workbooks associated with a connection id
    workbooksByConnection: Map<number, number[]>;
}

type WorkbookStateWithoutId = Omit<WorkbookState, "workbookId">;
type SetWorkbookRegistryAction = React.SetStateAction<WorkbookRegistry>;
export type WorkbookAllocator = (workbook: WorkbookStateWithoutId) => number;
export type modifyWorkbook = (action: WorkbookStateAction) => void;

const WORKBOOK_REGISTRY_CTX = React.createContext<[WorkbookRegistry, Dispatch<SetWorkbookRegistryAction>] | null>(null);
let NEXT_WORKBOOK_ID: number = 1;

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const WorkbookStateRegistry: React.FC<Props> = (props: Props) => {
    const reg = React.useState<WorkbookRegistry>(() => ({
        workbookMap: new Map(),
        workbooksByConnection: new Map()
    }));
    return (
        <WORKBOOK_REGISTRY_CTX.Provider value={reg}>
            {props.children}
        </WORKBOOK_REGISTRY_CTX.Provider>
    );
};

export function useWorkbookRegistry(): WorkbookRegistry {
    return React.useContext(WORKBOOK_REGISTRY_CTX)![0];
}

export function useWorkbookStateAllocator(): WorkbookAllocator {
    const [_reg, setReg] = React.useContext(WORKBOOK_REGISTRY_CTX)!;
    return React.useCallback((state: WorkbookStateWithoutId) => {
        const workbookId = NEXT_WORKBOOK_ID++;
        setReg((reg) => {
            const sameConnection = reg.workbooksByConnection.get(state.connectionId);
            if (sameConnection) {
                sameConnection.push(workbookId);
            } else {
                reg.workbooksByConnection.set(state.connectionId, [workbookId]);
            }
            reg.workbookMap.set(workbookId, { ...state, workbookId: workbookId })
            return { ...reg };
        });
        return workbookId;
    }, [setReg]);
}

export function useWorkbookState(id: number | null): [WorkbookState | null, modifyWorkbook] {
    const [registry, setRegistry] = React.useContext(WORKBOOK_REGISTRY_CTX)!;

    /// Wrapper to modify an individual workbook
    const dispatch = React.useCallback((action: WorkbookStateAction) => {
        setRegistry(
            (reg: WorkbookRegistry) => {
                // No id provided? Then do nothing.
                if (!id) {
                    return reg;
                }
                // Find the previous workbook state
                const prev = reg.workbookMap.get(id);
                // Ignore if the workbook does not exist
                if (!prev) {
                    console.warn(`no workbook registered with id ${id}`);
                    return reg;
                }
                // Reduce the workbook action
                const next = reduceWorkbookState(prev, action);
                // Should we delete the entry?
                if (action.type == DESTROY) {
                    reg.workbookMap.delete(id)
                    let sameConnection = reg.workbooksByConnection.get(prev.connectionId) ?? [];
                    sameConnection = sameConnection.filter(c => c != prev.workbookId);
                    if (sameConnection.length == 0) {
                        reg.workbooksByConnection.delete(prev.connectionId);
                    } else {
                        reg.workbooksByConnection.set(prev.connectionId, sameConnection);
                    }
                    return { ...reg }
                } else {
                    reg.workbookMap.set(id, next);
                    return { ...reg };
                }
            }
        );
    }, [id, setRegistry]);

    return [id == null ? null : registry.workbookMap.get(id) ?? null, dispatch];
};
