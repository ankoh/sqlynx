import type { SessionAttachment, SessionConnection, SessionData, SessionScript } from './storage_backend.js';
import { isValidUuid } from './session_validation.js';

/// The draft script of the editor, never a script of a session
const DRAFT_SCRIPT_FILE = 'dashql-draft.sql';
/// The maximum number of scripts and the maximum number of attachments of a session
export const MAX_SESSION_FILES = 2048;

const NATURAL_SORT = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/// Compare file names in natural order ("2_a.sql" before "10_a.sql")
export function compareFileNamesNaturally(a: string, b: string): number {
    return NATURAL_SORT.compare(a, b);
}

/// Is the value a plain file name that can't escape its folder?
export function isSafeFileName(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 255
        && value !== '.'
        && value !== '..'
        && !value.includes('/')
        && !value.includes('\\')
        && !value.includes('\0');
}

/// The key under which two file names denote the same file on a case-insensitive file system
function fileNameKey(name: string): string {
    return name.normalize('NFC').toLowerCase();
}

/// Is the value the name of a script file?
function isScriptFileName(value: unknown): value is string {
    return isSafeFileName(value)
        && value.toLowerCase().endsWith('.sql')
        && fileNameKey(value) !== DRAFT_SCRIPT_FILE;
}

/// The file lists of a session after the unusable entries were removed
export interface SanitizedSessionFiles {
    /// The scripts in feed order
    scripts: SessionScript[];
    /// The attachments in natural order
    attachments: SessionAttachment[];
    /// False when entries were removed
    valid: boolean;
}

/// Remove the entries of the file lists that can't be used: names that are not plain file names,
/// scripts without a valid connection id, duplicates and entries beyond the limit.
///
/// The lists of a session file are edited by hand, a bad entry therefore does not reject the session.
export function sanitizeSessionFiles(session: SessionData): SanitizedSessionFiles {
    let valid = true;
    const scripts: SessionScript[] = [];
    const scriptKeys = new Set<string>();
    const rawScripts: unknown = (session as { scripts?: unknown }).scripts;
    if (!Array.isArray(rawScripts)) valid = false;
    for (const script of Array.isArray(rawScripts) ? rawScripts : []) {
        if (scripts.length >= MAX_SESSION_FILES) {
            valid = false;
            break;
        }
        if (!isPlainObject(script) || !isScriptFileName(script.name)
            || typeof script.connectionId !== 'string' || !isValidUuid(script.connectionId)
            || scriptKeys.has(fileNameKey(script.name))) {
            valid = false;
            continue;
        }
        scriptKeys.add(fileNameKey(script.name));
        scripts.push({ name: script.name.normalize('NFC'), connectionId: script.connectionId });
    }
    const attachmentNames: string[] = [];
    const attachmentKeys = new Set<string>();
    const rawAttachments: unknown = (session as { attachments?: unknown }).attachments;
    if (!Array.isArray(rawAttachments)) valid = false;
    for (const attachment of Array.isArray(rawAttachments) ? rawAttachments : []) {
        if (attachmentNames.length >= MAX_SESSION_FILES) {
            valid = false;
            break;
        }
        if (!isPlainObject(attachment) || !isSafeFileName(attachment.name) || attachmentKeys.has(fileNameKey(attachment.name))) {
            valid = false;
            continue;
        }
        attachmentKeys.add(fileNameKey(attachment.name));
        attachmentNames.push(attachment.name.normalize('NFC'));
    }
    return { scripts, attachments: sessionAttachments(attachmentNames), valid };
}

/// The scripts of a session reconciled with the script files
export interface ReconciledSessionScripts {
    /// The scripts in feed order, one entry per file
    scripts: SessionScript[];
    /// Did the reconciliation change the scripts?
    changed: boolean;
}

/// Reconcile the scripts of a session with the script files that exist.
///
/// Entries keep their order. An entry without a file is dropped, the first of several entries for
/// a file wins and an entry that names a file with a different case or normalization takes the name
/// of the file. Files without an entry are appended in natural order with the default connection.
export function reconcileSessionScripts(
    scripts: readonly SessionScript[],
    fileNames: readonly string[],
    defaultConnectionId: string,
): ReconciledSessionScripts {
    const filesByName = new Set(fileNames);
    const filesByKey = new Map<string, string>();
    for (const name of fileNames) {
        if (!filesByKey.has(fileNameKey(name))) filesByKey.set(fileNameKey(name), name);
    }
    const listed = new Set<string>();
    const result: SessionScript[] = [];
    let changed = false;
    for (const script of scripts) {
        const name = filesByName.has(script.name) ? script.name : filesByKey.get(fileNameKey(script.name));
        if (name == null || listed.has(name)) {
            changed = true;
            continue;
        }
        if (name !== script.name) changed = true;
        listed.add(name);
        result.push({ name, connectionId: script.connectionId });
    }
    const unlisted = fileNames.filter(name => !listed.has(name)).sort(compareFileNamesNaturally);
    for (const name of unlisted) {
        listed.add(name);
        result.push({ name, connectionId: defaultConnectionId });
        changed = true;
    }
    return { scripts: result, changed };
}

/// The attachment list of a session for the given file names, in natural order
export function sessionAttachments(fileNames: readonly string[]): SessionAttachment[] {
    return [...fileNames].sort(compareFileNamesNaturally).map(name => ({ name }));
}

/// The ids of the connections that a session uses: the default connection and the connections of
/// its scripts, in this order
export function sessionConnectionIdsOf(defaultConnectionId: string, scripts: readonly SessionScript[]): string[] {
    return [...new Set([defaultConnectionId, ...scripts.map(script => script.connectionId)])];
}

/// The session with a new script list.
///
/// The connections of a session are derived from its scripts: the session holds a copy of the default
/// connection and of every connection that a script uses, nothing else. A copy that the session holds
/// wins over a given one, saving a connection patches the copies of the sessions that use it. A
/// connection without any copy is left out, the loader then runs its scripts on the default connection.
export function withSessionScripts(session: SessionData, scripts: SessionScript[], copies: readonly SessionConnection[] = []): SessionData {
    const known = new Map<string, SessionConnection>();
    for (const copy of [...session.connections, ...copies]) {
        if (!known.has(copy.connectionId)) known.set(copy.connectionId, copy);
    }
    const connections = sessionConnectionIdsOf(session.defaultConnectionId, scripts)
        .flatMap(connectionId => known.get(connectionId) ?? []);
    return { ...session, connections, scripts };
}

/// Replace the connection ids of the scripts, ids without a replacement are kept
export function remapSessionScripts(scripts: readonly SessionScript[], connectionIds: ReadonlyMap<string, string>): SessionScript[] {
    return scripts.map(script => ({ ...script, connectionId: connectionIds.get(script.connectionId) ?? script.connectionId }));
}

/// Do two script lists hold the same scripts in the same order?
export function sessionScriptsEqual(a: readonly SessionScript[], b: readonly SessionScript[]): boolean {
    return a.length === b.length && a.every((script, i) => script.name === b[i].name && script.connectionId === b[i].connectionId);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}
