import * as sqlynx from '@ankoh/sqlynx';

import { Tooltip, showTooltip } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { StateField } from '@codemirror/state';

import { SQLynxProcessor } from './sqlynx_processor';

function updateCursorTooltip(state: CursorTooltipState, transaction: Transaction): CursorTooltipState {
    const processor = transaction.state.field(SQLynxProcessor);
    if ((transaction.selection?.ranges.length ?? 0) == 0) {
        return state;
    }
    let nextTooltips = [];

    const tmpError = new sqlynx.proto.Error();
    const findErrorAtLocation = (
        buffer: {
            errors: (index: number, obj?: sqlynx.proto.Error) => sqlynx.proto.Error | null;
            errorsLength: () => number;
        },
        cursor: number,
    ) => {
        for (let i = 0; i < buffer.errorsLength(); ++i) {
            const error = buffer.errors(i, tmpError)!;
            const loc = error.location()!;
            if (loc.offset() <= cursor && loc.offset() + loc.length() > cursor) {
                return error;
            }
            return null;
        }
    };

    const cursorPos = transaction.selection!.ranges[0].head;
    if (processor.scriptBuffers.scanned) {
        const scanned = processor.scriptBuffers.scanned.read(new sqlynx.proto.ScannedScript());
        const error = findErrorAtLocation(scanned, cursorPos);
        if (error != null) {
            nextTooltips.push({
                pos: cursorPos,
                arrow: true,
                create: () => {
                    let dom = document.createElement('div');
                    dom.className = 'cm-tooltip-cursor';
                    dom.textContent = error.message();
                    return { dom };
                },
            });
        }
    }
    if (processor.scriptBuffers.parsed) {
        const parsed = processor.scriptBuffers.parsed.read(new sqlynx.proto.ParsedScript());
        const error = findErrorAtLocation(parsed, cursorPos);
        if (error != null) {
            nextTooltips.push({
                pos: cursorPos,
                arrow: true,
                create: () => {
                    let dom = document.createElement('div');
                    dom.className = 'cm-tooltip-cursor';
                    dom.textContent = error.message();
                    return { dom };
                },
            });
        }
    }
    return {
        tooltips: nextTooltips,
    };
}

interface CursorTooltipState {
    tooltips: Tooltip[];
}

const CursorTooltipField = StateField.define<CursorTooltipState>({
    create: () => {
        const config: CursorTooltipState = {
            tooltips: [],
        };
        return config;
    },
    update: (state: CursorTooltipState, transaction: Transaction) => {
        if (!transaction.docChanged && !transaction.selection) return state;
        return updateCursorTooltip(state, transaction);
    },
    provide: f => showTooltip.computeN([f], state => state.field(f).tooltips),
});

export const SQLynxTooltips = [CursorTooltipField];
