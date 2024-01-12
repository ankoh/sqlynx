import { lineNumbers } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';

import { SQLynxDecorations } from './sqlynx_decorations';
import { SQLynxProcessor } from './sqlynx_processor';
import { SQLynxTooltips } from './sqlynx_tooltips';
import { SQLynxGutters } from './sqlynx_gutters';
import { completeSQLynx } from './sqlynx_completion';

import { xcodeLight as THEME } from '@uiw/codemirror-themes-all';

export const SQLynxExtensions = [
    THEME,
    lineNumbers(),
    SQLynxProcessor,
    SQLynxDecorations,
    SQLynxTooltips,
    SQLynxGutters,
    autocompletion({
        override: [completeSQLynx],
    }),
];
