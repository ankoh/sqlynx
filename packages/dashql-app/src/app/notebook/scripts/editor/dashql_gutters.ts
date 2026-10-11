import * as dashql from '@ankoh/dashql-core';

import { gutter, GutterMarker } from '@codemirror/view';
import { Transaction, StateField } from '@codemirror/state';

import { DashQLProcessorPlugin, DashQLScriptKey } from './dashql_processor.js';

import icons from '@ankoh/dashql-svg-symbols';

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
    editorUpdate: dashql.buffers.editor.EditorUpdateT | null | undefined;
    errorLines: Set<number>;
}

const GutterState: StateField<State> = StateField.define<State>({
    // Create the initial state
    create: () => ({
        scriptKey: null,
        editorUpdate: null,
        errorLines: new Set(),
    }),
    update: (state: State, transaction: Transaction) => {
        // Program untouched?
        const processor = transaction.state.field(DashQLProcessorPlugin);
        if (
            processor.scriptKey === state.scriptKey &&
            processor.editorUpdate === state.editorUpdate
        ) {
            return state;
        }

        const errorLines: Set<number> = new Set();
        for (const diagnostic of processor.editorUpdate?.diagnostics ?? []) {
            if (diagnostic.severity !== dashql.buffers.editor.EditorDiagnosticSeverity.ERROR) continue;
            const loc = diagnostic.textSpan;
            if (loc == null) continue;
            errorLines.add(transaction.state.doc.lineAt(Number(loc.offset)).from);
        }
        return {
            scriptKey: processor.scriptKey,
            editorUpdate: processor.editorUpdate,
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

export const DashQLGutterPlugin = [GutterState, GutterExtension];
