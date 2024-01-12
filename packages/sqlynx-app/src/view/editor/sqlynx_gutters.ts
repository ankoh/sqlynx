import * as sqlynx from '@ankoh/sqlynx';

import { gutter, GutterMarker } from '@codemirror/view';
import { Transaction, StateField } from '@codemirror/state';

import { SQLynxProcessor, SQLynxScriptBuffers, SQLynxScriptKey } from './sqlynx_processor';

class ErrorMarker extends GutterMarker {
    toDOM() {
        return document.createTextNode('!');
    }
}

interface State {
    scriptKey: SQLynxScriptKey | null;
    scriptBuffers: SQLynxScriptBuffers | null;
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
        const processor = transaction.state.field(SQLynxProcessor);
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
                errors: (index: number, obj?: sqlynx.proto.Error) => sqlynx.proto.Error | null;
                errorsLength: () => number;
            },
            out: Set<number>,
        ) => {
            const tmp = new sqlynx.proto.Error();
            for (let i = 0; i < buffer.errorsLength(); ++i) {
                const error = buffer.errors(i, tmp)!;
                const loc = error.location()!;
                const line = transaction.state.doc.lineAt(loc.offset());
                out.add(line.from);
            }
        };
        const errorLines: Set<number> = new Set();
        if (processor.scriptBuffers.scanned) {
            const scanned = processor.scriptBuffers.scanned.read(new sqlynx.proto.ScannedScript());
            collectGutters(scanned, errorLines);
        }
        if (processor.scriptBuffers.parsed) {
            const parsed = processor.scriptBuffers.parsed.read(new sqlynx.proto.ParsedScript());
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

export const SQLynxGutters = [GutterState, GutterExtension];
