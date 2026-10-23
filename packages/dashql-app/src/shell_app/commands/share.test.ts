// @vitest-environment node
import { createShareCommand, type ShareCommandDependencies } from './share.js';

describe('SQL share command', () => {
    it('rejects arguments before opening the dialog', async () => {
        const dependencies: ShareCommandDependencies = { requestDialog: vi.fn() };

        await expect(createShareCommand(dependencies)[2](['unexpected'], {})).rejects.toThrow('usage: .share');
        expect(dependencies.requestDialog).not.toHaveBeenCalled();
    });

    it('opens the dialog once with the command abort signal and returns no output', async () => {
        const requestDialog = vi.fn().mockResolvedValue(undefined);
        const signal = new AbortController().signal;

        await expect(createShareCommand({ requestDialog })[2]([], { signal })).resolves.toBeUndefined();
        expect(requestDialog).toHaveBeenCalledOnce();
        expect(requestDialog).toHaveBeenCalledWith(signal);
    });

    it('does not open an already aborted request', async () => {
        const requestDialog = vi.fn();
        const abort = new AbortController();
        abort.abort();

        await expect(createShareCommand({ requestDialog })[2]([], { signal: abort.signal })).resolves.toBeUndefined();
        expect(requestDialog).not.toHaveBeenCalled();
    });
});
