// Based on https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample

import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    TextDocumentSyncKind,
    InitializeResult,
    DocumentUri,
    TextDocumentContentChangeEvent,
    TextEdit,
} from 'vscode-languageserver/node.js';

import * as fs from 'fs';
import * as flatsql from '@ankoh/flatsql';

// TODO: use `import.meta.resolve` as soon as it is no longer experimental
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fsql = await flatsql.FlatSQL.create(async (imports: WebAssembly.Imports) => {
    const wasmPath = require.resolve('@akohn/flatsql/dist/flatsql.wasm');
    const buf = await fs.promises.readFile(wasmPath);
    return await WebAssembly.instantiate(buf, imports);
});

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

connection.onInitialize((params: InitializeParams) => {
    const result: InitializeResult = {
        capabilities: {
            // For the time being, we only support full synchronization
            // TODO: support incremental sync
            textDocumentSync: TextDocumentSyncKind.Full,
            // Tell the client that this server supports formatting.
            documentFormattingProvider: true,
        },
    };
    return result;
});

class FlatSQLDocument {
    private _uri: DocumentUri;
    private _script: flatsql.FlatSQLScript;

    public constructor(uri: DocumentUri, languageId: string, version: number, content: string) {
        this._uri = uri;
        this._script = fsql.createScript();
        this._script.insertTextAt(0, content);
    }

    public discard() {
        this._script.delete();
    }

    public get uri(): string {
        return this._uri;
    }

    public fsqlScript() {
        return this._script;
    }

    public update(changes: TextDocumentContentChangeEvent[], version: number): void {
        for (const c of changes) {
            this._script.eraseTextRange(0, Number.MAX_SAFE_INTEGER);
            this._script.insertTextAt(0, c.text);
        }
    }
}

// Create a text document manager backed by `FlatSQLDocument`
const documents: TextDocuments<FlatSQLDocument> = new TextDocuments({
    create: (uri: DocumentUri, languageId: string, version: number, content: string) => {
        return new FlatSQLDocument(uri, languageId, version, content);
    },
    update: (document: FlatSQLDocument, changes: TextDocumentContentChangeEvent[], version: number) => {
        if (!(document instanceof FlatSQLDocument)) {
            throw new Error('Internal Error: unexpected document');
        }
        document.update(changes, version);
        return document;
    },
});

// Make sure we don't leak the underlying document in WebAssembly
documents.onDidClose(e => {
    e.document.discard();
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

connection.onDocumentFormatting(e => {
    const doc = documents.get(e.textDocument.uri);
    if (!doc) {
        return null;
    }
    const edits: TextEdit[] = [
        {
            range: {
                start: { line: 0, character: 0 },
                end: { line: Number.MAX_VALUE, character: Number.MAX_VALUE },
            },
            newText: doc.fsqlScript().prettyPrint(),
        },
    ];
    return edits;
});

// Listen on the connection
connection.listen();
