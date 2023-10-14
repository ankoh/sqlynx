import { lineNumbers } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';

import { completeSQLynx } from './sqlynx_completion';
import { SQLynxDecorations } from './sqlynx_decorations';
import { SQLynxProcessor } from './sqlynx_processor';

export const SQLynxExtensions = [
    lineNumbers(),
    SQLynxProcessor,
    ...SQLynxDecorations,
    autocompletion({
        override: [completeSQLynx],
    }),
];
