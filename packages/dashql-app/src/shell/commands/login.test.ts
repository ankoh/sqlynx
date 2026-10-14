// @vitest-environment node
import {
    createLoginCommand,
    type SalesforceLoginAuthentication,
    type SalesforceLoginCommandDependencies,
    type SalesforceLoginCommandContext,
} from './login.js';
import type * as connection from '@ankoh/dashql-jsonschema/connection.js';

function createDependencies(overrides: Partial<SalesforceLoginCommandDependencies> = {}) {
    const authentication: SalesforceLoginAuthentication = {
        coreAccessToken: {
            createdAt: new Date(0).toISOString(),
            accessToken: 'core-token',
            instanceUrl: 'https://example.my.salesforce.com',
        } as connection.SalesforceCoreAccessToken,
        dataCloudAccessToken: {
            instanceUrl: 'https://data.example.com',
            jwt: { raw: 'data-cloud-token', header: {}, payload: { audienceTenantId: 'tenant-1' } },
        } as connection.SalesforceDataCloudAccessToken,
    };
    const dependencies: SalesforceLoginCommandDependencies = {
        requestForm: vi.fn().mockResolvedValue({
            alias: 'salesforce',
            instanceUrl: 'https://example.my.salesforce.com',
            appConsumerKey: 'consumer-key',
            loginHint: '',
        }),
        hasAlias: vi.fn().mockReturnValue(false),
        authenticate: vi.fn().mockResolvedValue(authentication),
        attach: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
    return { dependencies, authentication };
}

function execute(dependencies: SalesforceLoginCommandDependencies, context: SalesforceLoginCommandContext = {}) {
    return createLoginCommand(dependencies)[2]([], context);
}

describe('Salesforce login command', () => {
    it('rejects arguments with usage before opening the form', async () => {
        const { dependencies } = createDependencies();
        await expect(createLoginCommand(dependencies)[2](['unexpected'], {})).rejects.toThrow('usage: .login');
        expect(dependencies.requestForm).not.toHaveBeenCalled();
    });

    it('returns no text when the form is cancelled', async () => {
        const { dependencies } = createDependencies({ requestForm: vi.fn().mockResolvedValue(null) });
        await expect(execute(dependencies)).resolves.toBeUndefined();
        expect(dependencies.authenticate).not.toHaveBeenCalled();
    });

    it('rejects duplicate aliases case-insensitively before authentication', async () => {
        const { dependencies } = createDependencies({
            requestForm: vi.fn().mockResolvedValue({
                alias: 'SaLeSfOrCe',
                instanceUrl: 'https://example.my.salesforce.com',
                appConsumerKey: 'consumer-key',
                loginHint: '',
            }),
            hasAlias: vi.fn(alias => alias.toLowerCase() === 'salesforce'),
        });
        await expect(execute(dependencies)).rejects.toThrow('Salesforce alias already exists: SaLeSfOrCe');
        expect(dependencies.authenticate).not.toHaveBeenCalled();
    });

    it('authenticates and attaches without resolving a catalog', async () => {
        const onSuccess = vi.fn();
        const { dependencies, authentication } = createDependencies({ onSuccess });
        const onProgress = vi.fn();
        await expect(execute(dependencies, { onProgress })).resolves.toBe('Attached Salesforce as salesforce');
        expect(dependencies.authenticate).toHaveBeenCalledWith(
            {
                alias: 'salesforce',
                instanceUrl: 'https://example.my.salesforce.com',
                appConsumerKey: 'consumer-key',
                loginHint: '',
            },
            undefined,
            onProgress,
        );
        expect(dependencies.attach).toHaveBeenCalledWith(
            'salesforce',
            authentication,
            undefined,
            onProgress,
        );
        expect(onProgress).toHaveBeenNthCalledWith(1, 'Authenticating with Salesforce');
        expect(onProgress).toHaveBeenNthCalledWith(2, 'Attaching Salesforce connection as salesforce');
        expect(onSuccess).toHaveBeenCalledWith(
            expect.objectContaining({ alias: 'salesforce' }),
            authentication,
        );
    });

    it('returns no text when authentication is aborted', async () => {
        const abort = new AbortController();
        const { dependencies } = createDependencies({
            authenticate: vi.fn(async () => {
                abort.abort();
                abort.signal.throwIfAborted();
                throw new Error('unreachable');
            }),
        });
        await expect(execute(dependencies, { signal: abort.signal })).resolves.toBeUndefined();
        expect(dependencies.attach).not.toHaveBeenCalled();
    });

    it('restarts the login flow after a handled error', async () => {
        const firstForm = {
            alias: 'salesforce',
            instanceUrl: 'https://example.my.salesforce.com',
            appConsumerKey: 'consumer-key',
            loginHint: '',
        };
        const secondForm = { ...firstForm };
        const requestForm = vi.fn()
            .mockResolvedValueOnce(firstForm)
            .mockResolvedValueOnce(secondForm);
        const authenticate = vi.fn()
            .mockRejectedValueOnce(new Error('authorization failed'));
        const onError = vi.fn(() => 'retry' as const);
        const { dependencies, authentication } = createDependencies({ requestForm, authenticate, onError });
        authenticate.mockResolvedValueOnce(authentication);

        await expect(execute(dependencies)).resolves.toBe('Attached Salesforce as salesforce');
        expect(requestForm).toHaveBeenCalledTimes(2);
        expect(authenticate).toHaveBeenNthCalledWith(1, firstForm, undefined, undefined);
        expect(authenticate).toHaveBeenNthCalledWith(2, secondForm, undefined, undefined);
        expect(onError).toHaveBeenCalledOnce();
        expect(dependencies.attach).toHaveBeenCalledOnce();
    });

    it('does not report success when attachment fails', async () => {
        const onSuccess = vi.fn();
        const { dependencies } = createDependencies({
            attach: vi.fn().mockRejectedValue(new Error('attachment failed')),
            onSuccess,
        });

        await expect(execute(dependencies)).rejects.toThrow('attachment failed');
        expect(onSuccess).not.toHaveBeenCalled();
    });
});
