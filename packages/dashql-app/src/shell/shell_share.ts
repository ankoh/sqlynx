import type * as dashql from '@ankoh/dashql-core';

import { BASE64URL_CODEC } from '../utils/base64.js';

/// The hash parameter carrying a shared script.
/// The hash never reaches the server and does not collide with the ?data= setup links of the app.
export const SHARE_SCRIPT_HASH_PARAMETER = 'script';

/// Pipe bytes through a (de)compression stream.
/// Reads the stream directly, Firefox logs corrupt input as console error when reading it through a Response.
async function pipeBytes(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
    const writer = transform.writable.getWriter();
    const written = writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
    // A failed write also fails the read below, report the read error
    written.catch(() => {});
    const reader = transform.readable.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        chunks.push(chunk.value);
        length += chunk.value.byteLength;
    }
    await written;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out.buffer;
}

/// Encode a script as base64url of its deflated UTF-8 bytes
export async function encodeShareScript(script: string): Promise<string> {
    const deflated = await pipeBytes(new TextEncoder().encode(script), new CompressionStream('deflate-raw'));
    return BASE64URL_CODEC.encode(deflated);
}

/// Decode a script encoded with encodeShareScript
export async function decodeShareScript(payload: string): Promise<string> {
    if (payload.length === 0 || !BASE64URL_CODEC.isValidBase64(payload)) {
        throw new Error('shared script is not valid base64url');
    }
    const deflated = new Uint8Array(BASE64URL_CODEC.decode(payload));
    const inflated = await pipeBytes(deflated, new DecompressionStream('deflate-raw'));
    return new TextDecoder('utf-8', { fatal: true }).decode(inflated);
}

/// Build the URL that opens the shell with a shared script
export function buildShareUrl(payload: string, location: Pick<Location, 'origin' | 'pathname' | 'search'> = window.location): string {
    return `${location.origin}${location.pathname}${location.search}#${SHARE_SCRIPT_HASH_PARAMETER}=${payload}`;
}

/// Read a shared script payload from the hash of the current URL and remove it from the address bar
export function readShareScriptFromLocation(): string | null {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const payload = params.get(SHARE_SCRIPT_HASH_PARAMETER);
    if (payload == null) return null;
    params.delete(SHARE_SCRIPT_HASH_PARAMETER);
    const hash = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash.length > 0 ? `#${hash}` : ''}`);
    return payload;
}

function terminateStatement(text: string): string {
    return text.endsWith(';') ? text : `${text};`;
}

/// Split SQL into its statements, keeping SQL that does not parse as a single statement
function splitSql(core: dashql.DashQL, catalog: dashql.DashQLCatalog, sql: string, out: string[]) {
    const trimmed = sql.trim();
    if (trimmed.length === 0) return;

    const bytes = new TextEncoder().encode(sql);
    const decoder = new TextDecoder();
    const script = core.createScript(catalog);
    let parsed: dashql.FlatBufferPtr<dashql.buffers.parser.ParsedScript> | null = null;
    try {
        script.replaceText(sql);
        script.parse();
        parsed = script.getParsed();
        const reader = parsed.read();
        if (reader.scannerErrorsLength() > 0 || reader.parserErrorsLength() > 0 || reader.statementsLength() === 0) {
            out.push(terminateStatement(trimmed));
            return;
        }
        for (let i = 0; i < reader.statementsLength(); ++i) {
            const span = reader.statements(i)!.statementSpan();
            if (!span) continue;
            const text = decoder.decode(bytes.subarray(span.offset(), span.offset() + span.length())).trim();
            if (text.length > 0) out.push(terminateStatement(text));
        }
    } finally {
        parsed?.destroy();
        script.destroy();
    }
}

/// Split a shared script into the prompts the shell offers one after another.
/// Lines starting with a dot are shell commands, everything between them is SQL.
export function splitShareScript(core: dashql.DashQL, catalog: dashql.DashQLCatalog, script: string): string[] {
    const out: string[] = [];
    let sql: string[] = [];
    for (const line of script.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('.')) {
            splitSql(core, catalog, sql.join('\n'), out);
            sql = [];
            out.push(trimmed);
        } else {
            sql.push(line);
        }
    }
    splitSql(core, catalog, sql.join('\n'), out);
    return out;
}
