// @vitest-environment node
import { SalesforceLoginHistoryStore } from './salesforce_login_history.js';

function notFound(): Error {
    return Object.assign(new Error('not found'), { name: 'NotFoundError' });
}

class MockFileHandle {
    text = '';

    async getFile() {
        return { text: async () => this.text } as File;
    }

    async createWritable() {
        return {
            write: async (value: string) => { this.text = value; },
            close: async () => {},
        } as unknown as FileSystemWritableFileStream;
    }
}

class MockDirectoryHandle {
    readonly directories = new Map<string, MockDirectoryHandle>();
    readonly files = new Map<string, MockFileHandle>();

    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
        let directory = this.directories.get(name);
        if (!directory && options?.create) {
            directory = new MockDirectoryHandle();
            this.directories.set(name, directory);
        }
        if (!directory) throw notFound();
        return directory as unknown as FileSystemDirectoryHandle;
    }

    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
        let file = this.files.get(name);
        if (!file && options?.create) {
            file = new MockFileHandle();
            this.files.set(name, file);
        }
        if (!file) throw notFound();
        return file as unknown as FileSystemFileHandle;
    }
}

describe('SalesforceLoginHistoryStore', () => {
    beforeEach(() => {
        vi.stubGlobal('navigator', {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('loads an empty history when its OPFS directory does not exist', async () => {
        const root = new MockDirectoryHandle();
        const store = new SalesforceLoginHistoryStore(async () => root as unknown as FileSystemDirectoryHandle);

        await expect(store.load()).resolves.toEqual([]);
    });

    it('persists entries ordered by most recent use', async () => {
        const root = new MockDirectoryHandle();
        const dates = [new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z')];
        const store = new SalesforceLoginHistoryStore(
            async () => root as unknown as FileSystemDirectoryHandle,
            () => dates.shift()!,
        );

        await store.record({
            organizationId: '00D-old',
            name: 'old',
            instanceUrl: 'https://old.my.salesforce.com',
            appConsumerKey: 'old-key',
        });
        await store.record({
            organizationId: '00D-new',
            name: 'new',
            instanceUrl: 'https://new.my.salesforce.com',
            appConsumerKey: 'new-key',
        });

        await expect(store.load()).resolves.toEqual([
            expect.objectContaining({ organizationId: '00D-new', lastUsedAt: '2026-02-01T00:00:00.000Z' }),
            expect.objectContaining({ organizationId: '00D-old', lastUsedAt: '2026-01-01T00:00:00.000Z' }),
        ]);
    });

    it('deduplicates org IDs case-insensitively and keeps the latest values', async () => {
        const root = new MockDirectoryHandle();
        const dates = [new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z')];
        const store = new SalesforceLoginHistoryStore(
            async () => root as unknown as FileSystemDirectoryHandle,
            () => dates.shift()!,
        );

        await store.record({
            organizationId: '00DABC',
            name: 'first',
            instanceUrl: 'https://first.my.salesforce.com',
            appConsumerKey: 'first-key',
        });
        await store.record({
            organizationId: '00dabc',
            name: 'current',
            instanceUrl: 'https://current.my.salesforce.com',
            appConsumerKey: 'current-key',
            loginHint: 'user@example.com',
        });

        await expect(store.load()).resolves.toEqual([{
            organizationId: '00dabc',
            name: 'current',
            instanceUrl: 'https://current.my.salesforce.com',
            appConsumerKey: 'current-key',
            loginHint: 'user@example.com',
            lastUsedAt: '2026-02-01T00:00:00.000Z',
        }]);
    });

    it('serializes concurrent writes with the Web Locks API', async () => {
        const root = new MockDirectoryHandle();
        let lock = Promise.resolve();
        const request = vi.fn((_name: string, callback: () => Promise<unknown>) => {
            const result = lock.then(callback);
            lock = result.then(() => undefined);
            return result;
        });
        vi.stubGlobal('navigator', { locks: { request } });
        const dates = [new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z')];
        const store = new SalesforceLoginHistoryStore(
            async () => root as unknown as FileSystemDirectoryHandle,
            () => dates.shift()!,
        );

        await Promise.all([
            store.record({
                organizationId: '00D-one',
                name: 'one',
                instanceUrl: 'https://one.my.salesforce.com',
                appConsumerKey: 'one-key',
            }),
            store.record({
                organizationId: '00D-two',
                name: 'two',
                instanceUrl: 'https://two.my.salesforce.com',
                appConsumerKey: 'two-key',
            }),
        ]);

        expect(request).toHaveBeenCalledTimes(2);
        await expect(store.load()).resolves.toHaveLength(2);
    });

    it('deletes an entry by org ID case-insensitively', async () => {
        const root = new MockDirectoryHandle();
        const store = new SalesforceLoginHistoryStore(async () => root as unknown as FileSystemDirectoryHandle);
        await store.record({
            organizationId: '00D-delete',
            name: 'delete me',
            instanceUrl: 'https://delete.my.salesforce.com',
            appConsumerKey: 'delete-key',
        });
        await store.record({
            organizationId: '00D-keep',
            name: 'keep me',
            instanceUrl: 'https://keep.my.salesforce.com',
            appConsumerKey: 'keep-key',
        });

        await expect(store.delete('00d-DELETE')).resolves.toEqual([
            expect.objectContaining({ organizationId: '00D-keep' }),
        ]);
        await expect(store.load()).resolves.toEqual([
            expect.objectContaining({ organizationId: '00D-keep' }),
        ]);
    });

    it('drops previously saved manual Data Cloud routing values when loading and rewriting history', async () => {
        const root = new MockDirectoryHandle();
        const directory = await root.getDirectoryHandle('dashql-shell', { create: true }) as unknown as MockDirectoryHandle;
        const file = await directory.getFileHandle('salesforce-login-history.json', { create: true }) as unknown as MockFileHandle;
        const entry = {
            organizationId: '00D-old',
            name: 'old',
            instanceUrl: 'https://old.my.salesforce.com',
            appConsumerKey: 'old-key',
            loginHint: 'user@example.com',
            lastUsedAt: '2026-01-01T00:00:00.000Z',
        };
        file.text = JSON.stringify({ version: 1, entries: [{
            ...entry, dataCloudInstanceUrl: 'https://data.example.com', dataCloudTenantId: 'old-tenant',
        }] });
        const store = new SalesforceLoginHistoryStore(async () => root as unknown as FileSystemDirectoryHandle);

        await expect(store.load()).resolves.toEqual([entry]);
        await store.record({
            organizationId: '00D-new', name: 'new', instanceUrl: 'https://new.my.salesforce.com', appConsumerKey: 'new-key',
        });
        expect(file.text).not.toContain('dataCloudInstanceUrl');
        expect(file.text).not.toContain('dataCloudTenantId');
    });

    it('rejects malformed history instead of overwriting it', async () => {
        const root = new MockDirectoryHandle();
        const directory = await root.getDirectoryHandle('dashql-shell', { create: true }) as unknown as MockDirectoryHandle;
        const file = await directory.getFileHandle('salesforce-login-history.json', { create: true }) as unknown as MockFileHandle;
        file.text = '{"version":1,"entries":[{"organizationId":1}]}';
        const store = new SalesforceLoginHistoryStore(async () => root as unknown as FileSystemDirectoryHandle);

        await expect(store.load()).rejects.toThrow('Invalid Salesforce login history format');
    });
});
