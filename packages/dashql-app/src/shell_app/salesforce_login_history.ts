import { STORAGE_SHELL_FOLDER } from '../app/storage/storage_backend.js';

const HISTORY_FILE = 'salesforce-login-history.json';
const HISTORY_LOCK = 'dashql-salesforce-login-history';

export interface SalesforceLoginHistoryEntry {
    organizationId: string;
    name: string;
    instanceUrl: string;
    appConsumerKey: string;
    loginHint?: string;
    lastUsedAt: string;
}

interface SalesforceLoginHistoryDocument {
    version: 1;
    entries: SalesforceLoginHistoryEntry[];
}

function isHistoryEntry(value: unknown): value is SalesforceLoginHistoryEntry {
    if (value == null || typeof value !== 'object') return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.organizationId === 'string'
        && entry.organizationId.length > 0
        && typeof entry.name === 'string'
        && typeof entry.instanceUrl === 'string'
        && typeof entry.appConsumerKey === 'string'
        && (entry.loginHint === undefined || typeof entry.loginHint === 'string')
        && typeof entry.lastUsedAt === 'string'
        && Number.isFinite(Date.parse(entry.lastUsedAt));
}

function sortByLastUse(entries: SalesforceLoginHistoryEntry[]): SalesforceLoginHistoryEntry[] {
    return entries.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
}

export class SalesforceLoginHistoryStore {
    constructor(
        private readonly getOPFSRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
        private readonly now: () => Date = () => new Date(),
    ) {}

    async load(): Promise<SalesforceLoginHistoryEntry[]> {
        const directory = await this.getDirectory(false);
        if (directory == null) return [];

        try {
            const handle = await directory.getFileHandle(HISTORY_FILE, { create: false });
            const document: unknown = JSON.parse(await (await handle.getFile()).text());
            if (document == null || typeof document !== 'object') {
                throw new Error('Invalid Salesforce login history format');
            }
            const candidate = document as Partial<SalesforceLoginHistoryDocument>;
            if (candidate.version !== 1 || !Array.isArray(candidate.entries) || !candidate.entries.every(isHistoryEntry)) {
                throw new Error('Invalid Salesforce login history format');
            }
            return sortByLastUse(candidate.entries.map(entry => ({
                organizationId: entry.organizationId,
                name: entry.name,
                instanceUrl: entry.instanceUrl,
                appConsumerKey: entry.appConsumerKey,
                ...(entry.loginHint !== undefined ? { loginHint: entry.loginHint } : {}),
                lastUsedAt: entry.lastUsedAt,
            })));
        } catch (error) {
            if ((error as DOMException).name === 'NotFoundError') return [];
            throw error;
        }
    }

    async record(entry: Omit<SalesforceLoginHistoryEntry, 'lastUsedAt'>): Promise<SalesforceLoginHistoryEntry[]> {
        if (navigator.locks != null) {
            return await navigator.locks.request(HISTORY_LOCK, () => this.recordUnlocked(entry));
        }
        return await this.recordUnlocked(entry);
    }

    private async recordUnlocked(entry: Omit<SalesforceLoginHistoryEntry, 'lastUsedAt'>): Promise<SalesforceLoginHistoryEntry[]> {
        const existing = await this.load();
        const organizationId = entry.organizationId.trim();
        if (!organizationId) throw new Error('Salesforce organization ID is required');

        const next: SalesforceLoginHistoryEntry = {
            organizationId,
            name: entry.name.trim(),
            instanceUrl: entry.instanceUrl.trim(),
            appConsumerKey: entry.appConsumerKey.trim(),
            ...(entry.loginHint?.trim() ? { loginHint: entry.loginHint.trim() } : {}),
            lastUsedAt: this.now().toISOString(),
        };
        const key = organizationId.toLowerCase();
        const entries = sortByLastUse([
            next,
            ...existing.filter(item => item.organizationId.toLowerCase() !== key),
        ]);
        await this.write(entries);
        return entries;
    }

    async delete(organizationId: string): Promise<SalesforceLoginHistoryEntry[]> {
        if (navigator.locks != null) {
            return await navigator.locks.request(HISTORY_LOCK, () => this.deleteUnlocked(organizationId));
        }
        return await this.deleteUnlocked(organizationId);
    }

    private async deleteUnlocked(organizationId: string): Promise<SalesforceLoginHistoryEntry[]> {
        const key = organizationId.trim().toLowerCase();
        if (!key) throw new Error('Salesforce organization ID is required');
        const entries = (await this.load()).filter(entry => entry.organizationId.toLowerCase() !== key);
        await this.write(entries);
        return entries;
    }

    private async write(entries: SalesforceLoginHistoryEntry[]): Promise<void> {
        const directory = await this.getDirectory(true);
        if (directory == null) throw new Error('Could not create Salesforce login history directory');
        const handle = await directory.getFileHandle(HISTORY_FILE, { create: true });
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify({ version: 1, entries } satisfies SalesforceLoginHistoryDocument, null, 2));
        await writable.close();
    }

    private async getDirectory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
        try {
            return await (await this.getOPFSRoot()).getDirectoryHandle(STORAGE_SHELL_FOLDER, { create });
        } catch (error) {
            if (!create && (error as DOMException).name === 'NotFoundError') return null;
            throw error;
        }
    }
}
