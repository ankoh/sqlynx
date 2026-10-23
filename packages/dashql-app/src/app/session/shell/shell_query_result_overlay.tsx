import * as React from 'react';
import icons from '@ankoh/dashql-svg-symbols';

import type { QueryExecutionState } from '../../../query/query_execution_state.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { useFocusTrap } from '../../../ui/foundations/focus.js';
import { Overlay, OverlaySize } from '../../../ui/foundations/overlay.js';
import { ScreenFullIcon, ScreenNormalIcon, SymbolIcon } from '../../../ui/foundations/symbol_icon.js';
import { VerticalTabs, VerticalTabProps, VerticalTabVariant } from '../../../ui/foundations/vertical_tabs.js';
import { QueryResultDetails } from '../compute/ui/query_result/query_result_details.js';
import { TableColumnHeader } from '../compute/ui/query_result/data_table_cell.js';
import { PlanView } from '../compute/ui/plan/plan_view.js';
import { useHyperPlan } from '../compute/ui/plan/hyper_plan_view.js';
import { TabHeader } from '../ui/tab_header.js';
import { getPlanResultText } from '../../../shell/shell_result.js';
import { classNames } from '../../../utils/classnames.js';
import * as styles from './shell_query_result_overlay.module.css';

export interface ShellQueryResultOverlayDependencies {
    QueryResultDetails: typeof QueryResultDetails;
    PlanView: typeof PlanView;
    useHyperPlan: typeof useHyperPlan;
}

const DEFAULT_DEPENDENCIES: ShellQueryResultOverlayDependencies = {
    QueryResultDetails,
    PlanView,
    useHyperPlan,
};

interface Props {
    query: QueryExecutionState;
    onClose: () => void;
    dismissOnClickOutside?: boolean;
    dependencies?: ShellQueryResultOverlayDependencies;
}

const MAX_OVERLAY_HEIGHT = 600;
const MIN_PLAN_OVERLAY_HEIGHT = 'min(360px, 80vh)';
const IGNORE_OUTSIDE_CLICK = () => {};
const CloseIcon = SymbolIcon('x_16');

const enum ResultTab {
    Data = 0,
    Plan = 1,
}

export const ShellQueryResultOverlay: React.FC<Props> = ({
    query,
    onClose,
    dismissOnClickOutside = true,
    dependencies = DEFAULT_DEPENDENCIES,
}) => {
    const ResultDetails = dependencies.QueryResultDetails;
    const PlanViewComponent = dependencies.PlanView;
    const closeRef = React.useRef<HTMLButtonElement>(null);
    const dialogRef = React.useRef<HTMLElement>(null);
    const [lockedHeight, setLockedHeight] = React.useState<{ queryId: number; height: number } | null>(null);
    const currentLockedHeight = lockedHeight?.queryId === query.queryId ? lockedHeight.height : null;
    const planText = React.useMemo(() => getPlanResultText(query.resultTable), [query.resultTable]);
    const { plan } = dependencies.useHyperPlan(planText);
    const hasPlan = plan != null;
    const [selectedTab, setSelectedTab] = React.useState<ResultTab>(ResultTab.Data);
    const selectedPlanQueryIdRef = React.useRef<number | null>(null);
    React.useLayoutEffect(() => {
        if (hasPlan && selectedPlanQueryIdRef.current !== query.queryId) {
            const height = dialogRef.current?.getBoundingClientRect().height;
            setLockedHeight(height == null ? null : { queryId: query.queryId, height });
            selectedPlanQueryIdRef.current = query.queryId;
            setSelectedTab(ResultTab.Plan);
        } else if (!hasPlan && selectedTab === ResultTab.Plan) {
            setLockedHeight(null);
            setSelectedTab(ResultTab.Data);
        }
    }, [hasPlan, query.queryId, selectedTab]);

    // Only the plan tab can be expanded to fill the window
    const [planExpanded, setPlanExpanded] = React.useState(false);
    const expanded = planExpanded && selectedTab === ResultTab.Plan;

    const closeButton = React.useMemo(() => (
        <IconButton
            ref={closeRef}
            variant={ButtonVariant.Invisible}
            size={ButtonSize.Small}
            aria-label="Close shell query results"
            onClick={onClose}
        >
            <CloseIcon size={16} />
        </IconButton>
    ), [onClose]);
    const planActions = React.useMemo(() => (
        <>
            <IconButton
                variant={ButtonVariant.Invisible}
                size={ButtonSize.Small}
                aria-label={planExpanded ? 'Restore plan size' : 'Expand plan'}
                aria-pressed={planExpanded}
                onClick={() => setPlanExpanded(e => !e)}
            >
                {planExpanded ? <ScreenNormalIcon size={16} /> : <ScreenFullIcon size={16} />}
            </IconButton>
            {closeButton}
        </>
    ), [closeButton, planExpanded]);
    const tabProps = React.useMemo<Record<ResultTab, VerticalTabProps>>(() => ({
        [ResultTab.Data]: {
            tabId: ResultTab.Data,
            icon: `${icons}#table_24`,
            labelShort: 'Data',
            ariaLabel: 'Query results',
            description: 'Query results',
        },
        [ResultTab.Plan]: {
            tabId: ResultTab.Plan,
            icon: `${icons}#plan`,
            labelShort: 'Plan',
            ariaLabel: 'Query plan',
            description: 'Query plan',
            disabled: !hasPlan,
        },
    }), [hasPlan]);
    const tabKeys = React.useMemo(() => hasPlan ? [ResultTab.Data, ResultTab.Plan] : [ResultTab.Data], [hasPlan]);
    const tabRenderers = React.useMemo(() => ({
        [ResultTab.Data]: () => (
            <ResultDetails
                query={query}
                debugMode={false}
                fitHeight
                maxHeight={MAX_OVERLAY_HEIGHT}
                columnHeader={TableColumnHeader.WithColumnPlots}
                actions={closeButton}
            />
        ),
        [ResultTab.Plan]: () => (
            <div className={styles.plan_tab}>
                <TabHeader title="Query Plan" actions={planActions} />
                <div className={styles.plan_body}>{plan != null && <PlanViewComponent plan={plan} />}</div>
            </div>
        ),
    }), [closeButton, planActions, plan, PlanViewComponent, query, ResultDetails]);
    useFocusTrap({
        containerRef: dialogRef as React.RefObject<HTMLElement>,
        initialFocusRef: dialogRef as React.RefObject<HTMLElement>,
        restoreFocusOnCleanUp: true,
    });
    return (
        <Overlay
            centered
            width={OverlaySize.XXL}
            height={OverlaySize.AUTO}
            maxHeight={OverlaySize.XL}
            expanded={expanded}
            initialFocusRef={dialogRef as React.RefObject<HTMLElement>}
            onEscape={onClose}
            onClickOutside={dismissOnClickOutside ? onClose : IGNORE_OUTSIDE_CLICK}
        >
            <section
                ref={dialogRef}
                className={classNames(styles.card, {
                    [styles.card_locked_height]: currentLockedHeight != null && !expanded,
                    [styles.card_expanded]: expanded,
                })}
                role="dialog"
                aria-modal="true"
                aria-label="Shell query results"
                tabIndex={-1}
                style={expanded ? undefined : {
                    height: currentLockedHeight ?? undefined,
                    minHeight: selectedTab === ResultTab.Plan ? MIN_PLAN_OVERLAY_HEIGHT : undefined,
                }}
            >
                <VerticalTabs
                    className={styles.tabs}
                    variant={VerticalTabVariant.Stacked}
                    tabKeys={tabKeys}
                    tabProps={tabProps}
                    tabRenderers={tabRenderers}
                    selectedTab={selectedTab}
                    selectTab={tab => setSelectedTab(tab as ResultTab)}
                />
            </section>
        </Overlay>
    );
};
