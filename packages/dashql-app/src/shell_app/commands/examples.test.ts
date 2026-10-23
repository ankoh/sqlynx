// @vitest-environment node
import { DashQLShell } from '../../shell/api.js';
import { examplesCommand, SHELL_EXAMPLES } from './examples.js';

declare const DASHQL_SHELL_PRECOMPILED: Promise<Uint8Array>;

describe('shell examples command', () => {
    it('lists the editable example queries without executing SQL', async () => {
        const executeQuery = vi.fn();
        const shell = await DashQLShell.create({
            environment: { executeQuery },
            commands: [examplesCommand],
            wasmBinary: await DASHQL_SHELL_PRECOMPILED,
        });
        try {
            shell.setPrompt('.help');
            expect(await shell.submitPrompt()).toContain('.examples');

            shell.setPrompt('.examples');
            expect(await shell.submitPrompt()).toBe(SHELL_EXAMPLES + '\r\n');
            expect(executeQuery).not.toHaveBeenCalled();

            shell.setPrompt('.examples q1');
            await expect(shell.submitPrompt()).resolves.toBe('usage: .examples\r\n');
        } finally {
            shell.destroy();
        }
    });
});
