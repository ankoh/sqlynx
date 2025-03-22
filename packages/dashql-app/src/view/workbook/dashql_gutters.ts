import * as dashql from '@ankoh/dashql-core';

import { gutter, GutterMarker } from '@codemirror/view';
import { Transaction, StateField } from '@codemirror/state';

import { DashQLProcessor, DashQLScriptBuffers, DashQLScriptKey } from './dashql_processor.js';

import * as icons from '../../../static/svg/symbols.generated.svg';

import './dashql_gutters.css';

class ErrorMarker extends GutterMarker {
    toDOM() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'dashql-gutter-error');
        svg.setAttribute('width', '14px');
        svg.setAttribute('height', '14px');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `${icons}#close_circle`);
        svg.appendChild(use);
        return svg;
    }
}

interface State {
    scriptKey: DashQLScriptKey | null;
    scriptBuffers: DashQLScriptBuffers | null;
    errorLines: Set<number>;
}

const GutterState: StateField<State> = StateField.define<State>({
    // Create the initial state
    create: () => ({
        scriptKey: null,
        scriptBuffers: null,
        errorLines: new Set(),
    }),
    update: (state: State, transaction: Transaction) => {
        // Program untouched?
        const processor = transaction.state.field(DashQLProcessor);
        if (
            processor.scriptKey === state.scriptKey &&
            processor.scriptBuffers.scanned === state.scriptBuffers?.scanned &&
            processor.scriptBuffers.parsed === state.scriptBuffers?.parsed &&
            processor.scriptBuffers.analyzed === state.scriptBuffers?.analyzed
        ) {
            return state;
        }

        const collectGutters = (
            buffer: {
                errors: (index: number, obj?: dashql.buffers.Error) => dashql.buffers.Error | null;
                errorsLength: () => number;
            },
            out: Set<number>,
        ) => {
            const tmp = new dashql.buffers.Error();
            for (let i = 0; i < buffer.errorsLength(); ++i) {
                const error = buffer.errors(i, tmp)!;
                const loc = error.location()!;
                const line = transaction.state.doc.lineAt(loc.offset());
                out.add(line.from);
            }
        };
        const errorLines: Set<number> = new Set();
        if (processor.scriptBuffers.scanned) {
            const scanned = processor.scriptBuffers.scanned.read();
            collectGutters(scanned, errorLines);
        }
        if (processor.scriptBuffers.parsed) {
            const parsed = processor.scriptBuffers.parsed.read();
            collectGutters(parsed, errorLines);
        }
        return {
            scriptKey: processor.scriptKey,
            scriptBuffers: processor.scriptBuffers,
            errorLines,
        };
    },
});

const GutterExtension = gutter({
    lineMarker(view, line) {
        const gutters = view.state.field(GutterState);
        if (gutters.errorLines.has(line.from)) {
            return new ErrorMarker();
        }
        return null;
    },
    initialSpacer() {
        return new ErrorMarker();
    },
});

export const DashQLGutters = [GutterState, GutterExtension];
