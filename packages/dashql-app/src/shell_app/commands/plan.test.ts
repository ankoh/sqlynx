// @vitest-environment node
import { createPlanCommand, type PlanCommandDependencies } from './plan.js';

describe('query plan command', () => {
    it('rejects arguments before opening the dialog', async () => {
        const dependencies: PlanCommandDependencies = { requestDialog: vi.fn() };

        await expect(createPlanCommand(dependencies)[2](['unexpected'], {})).rejects.toThrow('usage: .plan');
        expect(dependencies.requestDialog).not.toHaveBeenCalled();
    });

    it('opens the dialog once with the command abort signal and returns no output', async () => {
        const requestDialog = vi.fn().mockResolvedValue(undefined);
        const signal = new AbortController().signal;

        await expect(createPlanCommand({ requestDialog })[2]([], { signal })).resolves.toBeUndefined();
        expect(requestDialog).toHaveBeenCalledOnce();
        expect(requestDialog).toHaveBeenCalledWith(signal);
    });

    it('does not open an already aborted request', async () => {
        const requestDialog = vi.fn();
        const abort = new AbortController();
        abort.abort();

        await expect(createPlanCommand({ requestDialog })[2]([], { signal: abort.signal })).resolves.toBeUndefined();
        expect(requestDialog).not.toHaveBeenCalled();
    });
});
