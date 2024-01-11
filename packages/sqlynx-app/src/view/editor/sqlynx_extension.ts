import { lineNumbers } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';

import { completeSQLynx } from './sqlynx_completion';
import { SQLynxDecorations } from './sqlynx_decorations';
import { SQLynxProcessor } from './sqlynx_processor';

import { basicLight } from 'cm6-theme-basic-light';

const THEME = basicLight;

export const SQLynxExtensions = [
    THEME,
    lineNumbers(),
    SQLynxProcessor,
    ...SQLynxDecorations,
    autocompletion({
        override: [completeSQLynx],
    }),
];
