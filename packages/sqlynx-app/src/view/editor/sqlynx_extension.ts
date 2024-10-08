import { autocompletion } from '@codemirror/autocomplete';

import { SQLynxDecorations } from './sqlynx_decorations.js';
import { SQLynxProcessor } from './sqlynx_processor.js';
import { SQLynxTooltips } from './sqlynx_tooltips.js';
import { SQLynxGutters } from './sqlynx_gutters.js';
import { completeSQLynx } from './sqlynx_completion.js';

export const SQLynxExtensions = [
    SQLynxProcessor,
    SQLynxDecorations,
    SQLynxTooltips,
    SQLynxGutters,
    autocompletion({
        override: [completeSQLynx],
    }),
];
