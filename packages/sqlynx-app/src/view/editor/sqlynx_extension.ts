import { lineNumbers } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';

import { SQLynxDecorations } from './sqlynx_decorations';
import { SQLynxProcessor } from './sqlynx_processor';
import { SQLynxTooltips } from './sqlynx_tooltips';
import { SQLynxGutters } from './sqlynx_gutters';
import { completeSQLynx } from './sqlynx_completion';

import * as themes from './themes';

export const SQLynxExtensions = [
    themes.xcode.xcodeLight,
    lineNumbers(),
    SQLynxProcessor,
    SQLynxDecorations,
    SQLynxTooltips,
    SQLynxGutters,
    autocompletion({
        override: [completeSQLynx],
    }),
];
