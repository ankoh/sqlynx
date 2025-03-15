import { autocompletion } from '@codemirror/autocomplete';

import { DashQLDecorations } from './dashql_decorations.js';
import { DashQLProcessor } from './dashql_processor.js';
import { DashQLTooltips } from './dashql_tooltips.js';
import { DashQLGutters } from './dashql_gutters.js';
import { completeDashQL } from './dashql_completion.js';

export const DashQLExtensions = [
    DashQLProcessor,
    DashQLDecorations,
    DashQLTooltips,
    DashQLGutters,
    autocompletion({
        override: [completeDashQL],
    }),
];
