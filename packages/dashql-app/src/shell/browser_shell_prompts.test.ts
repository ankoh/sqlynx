import * as arrow from 'apache-arrow';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DashQLShell } from './api.js';
import { embedDashQLShell, type BrowserShellController } from './browser_shell.js';

declare const DASHQL_SHELL_PRECOMPILED: Promise<Uint8Array>;

describe('browser shell prompt queue', () => {
    let container: HTMLDivElement;
    let shell: DashQLShell;
    let controller: BrowserShellController;
    let queries: string[];

    beforeEach(async () => {
        queries = [];
        container = document.createElement('div');
        container.style.width = '800px';
        container.style.height = '400px';
        document.body.appendChild(container);
        shell = await DashQLShell.create({
            environment: {
                executeQuery: async query => {
                    queries.push(query);
                    return arrow.tableToIPC(arrow.tableFromArrays({}), 'file');
                },
            },
            terminalColumns: 80,
            wasmBinary: await DASHQL_SHELL_PRECOMPILED,
        });
        controller = await embedDashQLShell({ container, shell });
    });

    afterEach(() => {
        controller.dispose();
        shell.destroy();
        container.remove();
    });

    function promptText(): string {
        return shell.movePromptRight().text;
    }

    function press(key: string, init: KeyboardEventInit = {}) {
        const input = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    }

    async function settle() {
        for (let i = 0; i < 20 && promptText().length === 0 && queries.length > 0; ++i) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    it('fills in each queued prompt after the previous one ran', async () => {
        controller.queuePrompts(['select 1;', 'select 2;']);
        expect(promptText()).toBe('select 1;');
        expect(queries).toEqual([]);

        press('Enter');
        await settle();
        expect(queries).toHaveLength(1);
        expect(promptText()).toBe('select 2;');

        press('Enter');
        await settle();
        expect(queries).toHaveLength(2);
        expect(promptText()).toBe('');
    });

    it('drops the remaining prompts on Ctrl+C', async () => {
        controller.queuePrompts(['select 1;', 'select 2;']);
        press('c', { ctrlKey: true });
        expect(promptText()).toBe('');

        shell.setPrompt('select 3;');
        press('Enter');
        await settle();
        expect(queries).toHaveLength(1);
        expect(promptText()).toBe('');
    });
});
