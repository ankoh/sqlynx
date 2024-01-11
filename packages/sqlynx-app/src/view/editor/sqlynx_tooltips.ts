import { Tooltip, showTooltip } from '@codemirror/view';
import { Transaction, EditorState } from '@codemirror/state';
import { StateField } from '@codemirror/state';

function getCursorTooltips(state: EditorState) {
    return [];
}

type StateType = readonly Tooltip[];

const CursorTooltipField = StateField.define<StateType>({
    create: getCursorTooltips,
    update: (state: StateType, transaction: Transaction) => {
        if (!transaction.docChanged && !transaction.selection) return state;
        return getCursorTooltips(transaction.state);
    },
    provide: f => showTooltip.computeN([f], state => state.field(f)),
});

export const SQLynxTooltips = [CursorTooltipField];
