import type { DashQLShellCommand } from '../../shell/api.js';

export interface PlanCommandDependencies {
    requestDialog(signal?: AbortSignal): Promise<void>;
}

export function createPlanCommand(dependencies: PlanCommandDependencies): DashQLShellCommand {
    return [
        'plan',
        'Open the query plan viewer',
        async (args, context) => {
            if (args.length !== 0) throw new Error('usage: .plan');
            if (context.signal?.aborted) return;
            await dependencies.requestDialog(context.signal);
        },
    ];
}
