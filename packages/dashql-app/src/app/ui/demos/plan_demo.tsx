import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as styles from './plan_demo.module.css';

import { useDashQLCoreSetup } from '../../providers/core_provider.js';
import { createPlanLayoutConfig, PlanView } from '../../session/compute/ui/plan/plan_view.js';
import { HYPER_EXAMPLE_PLAN } from './plan_demo_example.js';

export function HyperPlanDemoPage(): React.ReactElement {
    const coreSetup = useDashQLCoreSetup();
    const [planText, setPlanText] = React.useState(HYPER_EXAMPLE_PLAN);
    const [plan, setPlan] = React.useState<dashql.FlatBufferPtr<dashql.buffers.view.PlanViewModel> | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const layoutConfig = React.useMemo(() => createPlanLayoutConfig(true), []);
    const viewModelRef = React.useRef<dashql.DashQLPlanViewModel | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        const render = async () => {
            const core = await coreSetup('hyper_plan_demo');
            if (cancelled) return;
            viewModelRef.current ??= core.createPlanViewModel(layoutConfig);
            try {
                const nextPlan = viewModelRef.current.loadHyperPlan(planText);
                if (!cancelled) {
                    setPlan(nextPlan);
                    setError(null);
                }
            } catch (cause) {
                if (!cancelled) {
                    setPlan(null);
                    setError(cause instanceof Error ? cause.message : 'Could not render plan');
                }
            }
        };
        void render();
        return () => { cancelled = true; };
    }, [coreSetup, layoutConfig, planText]);

    React.useEffect(() => () => {
        viewModelRef.current?.destroy();
        viewModelRef.current = null;
    }, []);

    return (
        <div className={styles.root}>
            <section className={styles.demo_section}>
                <h1 className={styles.demo_section_header}>Hyper Plan Demo</h1>
                <div className={styles.demo_section_body}>
                    <label className={styles.input_label}>
                        Plan JSON
                        <textarea onChange={event => setPlanText(event.target.value)} value={planText} />
                    </label>
                    {error != null && <div role="alert">{error}</div>}
                    {plan != null && <PlanView plan={plan} showProgress />}
                </div>
            </section>
        </div>
    );
}
