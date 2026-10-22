import * as React from 'react';

import * as dashql from '@ankoh/dashql-core';
import { useDashQLCoreSetup } from '../../../../providers/core_provider.js';
import { createPlanLayoutConfig, PlanView } from './plan_view.js';

export interface HyperPlanViewProps {
    planText: string;
    className?: string;
    fallback?: React.ReactNode;
}

export interface HyperPlanState {
    plan: dashql.FlatBufferPtr<dashql.buffers.view.PlanViewModel> | null;
    rejected: boolean;
}

export function useHyperPlan(planText: string | null): HyperPlanState {
    const coreSetup = useDashQLCoreSetup();
    const layoutConfig = React.useMemo(() => createPlanLayoutConfig(false), []);
    const viewModelRef = React.useRef<dashql.DashQLPlanViewModel | null>(null);
    const [plan, setPlan] = React.useState<dashql.FlatBufferPtr<dashql.buffers.view.PlanViewModel> | null>(null);
    const [rejected, setRejected] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        setPlan(null);
        setRejected(false);
        if (planText == null) return;
        const load = async () => {
            const core = await coreSetup('hyper_plan_view');
            if (cancelled) return;
            viewModelRef.current ??= core.createPlanViewModel(layoutConfig);
            try {
                const nextPlan = viewModelRef.current.loadHyperPlan(planText);
                if (nextPlan.read().operatorsLength() === 0) {
                    throw new Error('Plan contains no operators');
                }
                if (!cancelled) {
                    setPlan(nextPlan);
                }
            } catch (error) {
                console.warn(error);
                if (!cancelled) {
                    setRejected(true);
                }
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [coreSetup, layoutConfig, planText]);

    React.useEffect(() => () => {
        viewModelRef.current?.destroy();
        viewModelRef.current = null;
    }, []);

    return { plan, rejected };
}

export function HyperPlanView(props: HyperPlanViewProps) {
    const { plan, rejected } = useHyperPlan(props.planText);

    if (rejected) return props.fallback ?? null;
    return <div className={props.className}>{plan != null && <PlanView plan={plan} />}</div>;
}
