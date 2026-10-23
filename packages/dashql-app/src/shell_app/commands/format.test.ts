// @vitest-environment node
import { createFormatCommand, type FormatCommandDependencies } from './format.js';

describe('SQL format command', () => {
    it('rejects arguments before opening the dialog', async () => {
        const dependencies: FormatCommandDependencies = { requestDialog: vi.fn() };

        await expect(createFormatCommand(dependencies)[2](['unexpected'], {})).rejects.toThrow('usage: .format');
        expect(dependencies.requestDialog).not.toHaveBeenCalled();
    });

    it('opens the dialog once with the command abort signal and returns no output', async () => {
        const requestDialog = vi.fn().mockResolvedValue(undefined);
        const signal = new AbortController().signal;

        await expect(createFormatCommand({ requestDialog })[2]([], { signal })).resolves.toBeUndefined();
        expect(requestDialog).toHaveBeenCalledOnce();
        expect(requestDialog).toHaveBeenCalledWith(signal);
    });

    it('does not open an already aborted request', async () => {
        const requestDialog = vi.fn();
        const abort = new AbortController();
        abort.abort();

        await expect(createFormatCommand({ requestDialog })[2]([], { signal: abort.signal })).resolves.toBeUndefined();
        expect(requestDialog).not.toHaveBeenCalled();
    });
});
