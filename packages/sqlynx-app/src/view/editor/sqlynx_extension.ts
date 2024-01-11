import { lineNumbers } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';

import { completeSQLynx } from './sqlynx_completion';
import { SQLynxDecorations } from './sqlynx_decorations';
import { SQLynxProcessor } from './sqlynx_processor';

import { xcodeLight as THEME } from '@uiw/codemirror-themes-all';

export const SQLynxExtensions = [
    THEME,
    lineNumbers(),
    SQLynxProcessor,
    ...SQLynxDecorations,
    autocompletion({
        override: [completeSQLynx],
    }),
];
