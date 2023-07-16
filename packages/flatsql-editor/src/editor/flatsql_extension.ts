import { lineNumbers } from '@codemirror/view';

import { FlatSQLDecorations } from './flatsql_decorations';
import { FlatSQLAnalyzer } from './flatsql_analyzer';

export const FlatSQLExtensions = [lineNumbers(), FlatSQLAnalyzer, ...FlatSQLDecorations];
