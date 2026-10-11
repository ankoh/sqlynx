import * as dashql from '@ankoh/dashql-core';

import { Tooltip, showTooltip } from '@codemirror/view';
import { Transaction, StateField } from '@codemirror/state';

import { DashQLCompletionStatus, DashQLProcessorPlugin } from './dashql_processor.js';

interface CursorError {
    message: string;
    from: number;
    to: number;
}

function findErrorAtCursor(update: dashql.buffers.editor.EditorUpdateT | null | undefined, cursor: number): CursorError | null {
    for (const diagnostic of update?.diagnostics ?? []) {
        const loc = diagnostic.textSpan;
        if (loc == null) continue;
        const from = Number(loc.offset);
        const to = Number(loc.offset + loc.length);
        if (from <= cursor && to >= cursor) {
            return { message: typeof diagnostic.message === 'string' ? diagnostic.message : '', from, to };
        }
    }
    return null;
}

function createTooltip(error: CursorError): Tooltip {
    return {
        pos: error.from,
        end: error.to,
        arrow: true,
        create: () => {
            const dom = document.createElement('div');
            dom.className = 'cm-tooltip-cursor-diagnostics';
            dom.textContent = error.message;
            return { dom };
        },
    };
}

interface CursorDiagnosticsSnapshot {
    update: dashql.buffers.editor.EditorUpdateT | null | undefined;
    pos: number;
    tooltip: Tooltip | null;
}

const CursorDiagnosticsField = StateField.define<CursorDiagnosticsSnapshot>({
    create: () => ({ update: null, pos: -1, tooltip: null }),
    update: (prev: CursorDiagnosticsSnapshot, transaction: Transaction) => {
        const pos = transaction.state.selection.main.head;
        const processor = transaction.state.field(DashQLProcessorPlugin);
        const update = processor.editorUpdate;

        // Nothing changed?
        if (update === prev.update && pos === prev.pos) {
            return prev;
        }

        // Hide tooltip during active completion
        if (processor.scriptCompletion?.status == DashQLCompletionStatus.AVAILABLE) {
            return { update, pos, tooltip: null };
        }

        const error = findErrorAtCursor(update, pos);
        return { update, pos, tooltip: error ? createTooltip(error) : null };
    },
    provide: f => showTooltip.computeN([f], state => {
        const tooltip = state.field(f).tooltip;
        return tooltip ? [tooltip] : [];
    }),
});

export const DashQLCursorDiagnosticsPlugin = [CursorDiagnosticsField];
