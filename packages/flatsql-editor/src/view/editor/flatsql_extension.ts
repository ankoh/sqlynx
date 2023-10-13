import { lineNumbers } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';

import { completeFlatSQL } from './flatsql_completion';
import { FlatSQLDecorations } from './flatsql_decorations';
import { FlatSQLProcessor } from './flatsql_processor';

export const FlatSQLExtensions = [
    lineNumbers(),
    FlatSQLProcessor,
    ...FlatSQLDecorations,
    autocompletion({
        override: [completeFlatSQL],
    }),
];
