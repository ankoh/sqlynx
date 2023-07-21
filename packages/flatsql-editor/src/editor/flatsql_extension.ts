import { lineNumbers } from '@codemirror/view';

import { FlatSQLDecorations } from './flatsql_decorations';
import { FlatSQLProcessor } from './flatsql_processor';

export const FlatSQLExtensions = [lineNumbers(), FlatSQLProcessor, ...FlatSQLDecorations];
