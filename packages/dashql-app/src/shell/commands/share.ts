import type { DashQLShellCommand } from '../api.js';

export interface ShareCommandDependencies {
    requestDialog(signal?: AbortSignal): Promise<void>;
}

export function createShareCommand(dependencies: ShareCommandDependencies): DashQLShellCommand {
    return [
        'share',
        'Share a SQL script as a URL',
        async (args, context) => {
            if (args.length !== 0) throw new Error('usage: .share');
            if (context.signal?.aborted) return;
            await dependencies.requestDialog(context.signal);
        },
    ];
}
