import * as sqlynx from '@ankoh/sqlynx';

import { Tooltip, showTooltip, hoverTooltip, EditorView } from '@codemirror/view';
import { Transaction, StateField, EditorState } from '@codemirror/state';

import { SQLynxProcessor } from './sqlynx_processor';

function createCursorTooltip(state: EditorState, pos: number): Tooltip | null {
    const processor = state.field(SQLynxProcessor);
    const findErrorAtLocation = (
        buffer: {
            errors: (index: number, obj?: sqlynx.proto.Error) => sqlynx.proto.Error | null;
            errorsLength: () => number;
        },
        cursor: number,
    ) => {
        const tmp = new sqlynx.proto.Error();
        for (let i = 0; i < buffer.errorsLength(); ++i) {
            const error = buffer.errors(i, tmp)!;
            const loc = error.location()!;
            if (loc.offset() <= cursor && loc.offset() + loc.length() > cursor) {
                return error;
            }
            return null;
        }
    };

    if (processor.scriptBuffers.scanned) {
        const scanned = processor.scriptBuffers.scanned.read(new sqlynx.proto.ScannedScript());
        const error = findErrorAtLocation(scanned, pos);
        if (error != null) {
            return {
                pos,
                arrow: true,
                create: () => {
                    let dom = document.createElement('div');
                    dom.className = 'cm-tooltip-cursor';
                    dom.textContent = error.message();
                    return { dom };
                },
            };
        }
    }
    if (processor.scriptBuffers.parsed) {
        const parsed = processor.scriptBuffers.parsed.read(new sqlynx.proto.ParsedScript());
        const error = findErrorAtLocation(parsed, pos);
        if (error != null) {
            return {
                pos,
                arrow: true,
                create: () => {
                    let dom = document.createElement('div');
                    dom.className = 'cm-tooltip-cursor';
                    dom.textContent = error.message();
                    return { dom };
                },
            };
        }
    }
    return null;
}

const CursorTooltipField = StateField.define<Tooltip | null>({
    create: () => null,
    update: (state: Tooltip | null, transaction: Transaction) => {
        if (!transaction.docChanged && !transaction.selection) return state;
        const pos = transaction.selection?.ranges ?? [];
        if (pos.length == 0) {
            return null;
        }
        return createCursorTooltip(transaction.state, pos[0].head);
    },
    provide: f => showTooltip.computeN([f], state => [state.field(f)]),
});

const HoverTooltip = hoverTooltip(
    (view: EditorView, pos: number, _side: 1 | -1): Tooltip | null => {
        const cursorTooltip = view.state.field(CursorTooltipField);
        if (cursorTooltip != null) {
            return null;
        }
        return createCursorTooltip(view.state, pos);
    },
    {
        hideOn: (tr: Transaction, tooltip: Tooltip): boolean => {
            const cursorTooltip = tr.state.field(CursorTooltipField);
            return cursorTooltip != null;
        },
    },
);

export const SQLynxTooltips = [CursorTooltipField, HoverTooltip];
