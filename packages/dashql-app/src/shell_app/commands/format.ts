import type { DashQLShellCommand } from '../../shell/api.js';

export interface FormatCommandDependencies {
    requestDialog(signal?: AbortSignal): Promise<void>;
}

export function createFormatCommand(dependencies: FormatCommandDependencies): DashQLShellCommand {
    return [
        'format',
        'Open the SQL formatter',
        async (args, context) => {
            if (args.length !== 0) throw new Error('usage: .format');
            if (context.signal?.aborted) return;
            await dependencies.requestDialog(context.signal);
        },
    ];
}
