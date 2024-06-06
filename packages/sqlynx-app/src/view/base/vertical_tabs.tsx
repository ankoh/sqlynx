import * as React from 'react';

import { classNames } from '../../utils/classnames.js';

import * as styles from './vertical_tabs.module.css';

type Key = number;

export interface VerticalTabRenderers<TabProps extends VerticalTabProps> {
    [key: Key]: (props: TabProps) => React.ReactElement;
}

export interface VerticalTabProps {
    tabId: number;
    icon: string;
    iconActive?: string;
    labelShort: string;
    labelLong?: string;
    disabled?: boolean;
}

export enum VerticalTabVariant {
    Stacked = 0,
    Wide = 1,
}

interface Props<TabProps extends VerticalTabProps> {
    className?: string;
    variant: VerticalTabVariant;
    tabKeys: Key[];
    tabProps: Record<Key, TabProps>;
    tabRenderers: VerticalTabRenderers<TabProps>;
    selectedTab: Key;
    selectTab: (tab: Key) => void;
}

export function VerticalTabs<TabProps extends VerticalTabProps>(props: Props<TabProps>): React.ReactElement {
    const selectTab = React.useCallback((elem: React.MouseEvent) => {
        const target = elem.currentTarget as HTMLDivElement;
        props.selectTab(Number.parseInt(target.dataset.tab ?? '0'));
    }, []);
    const tabBodyRenderer = props.tabRenderers[props.selectedTab];
    const tabBody = tabBodyRenderer ? tabBodyRenderer(props.tabProps[props.selectedTab]) : undefined;

    const renderStackedTab = (tabProps: VerticalTabProps) => (
        <div
            key={tabProps.tabId}
            className={classNames(styles.stacked_tab, {
                [styles.stacked_tab_active]: tabProps.tabId == props.selectedTab,
                [styles.stacked_tab_disabled]: tabProps.disabled,
            })}
            data-tab={tabProps.tabId}
            onClick={tabProps.disabled ? undefined : selectTab}
        >
            <button className={styles.stacked_tab_icon}>
                <svg width="18px" height="16px">
                    <use xlinkHref={(tabProps.tabId == props.selectedTab && tabProps.iconActive) ? tabProps.iconActive : tabProps.icon} />
                </svg>
            </button>
            <div className={styles.stacked_tab_label}>{tabProps.labelShort}</div>
        </div>
    );
    const renderWideTab = (tabProps: VerticalTabProps) => (
        <div
            key={tabProps.tabId}
            className={classNames(styles.wide_tab, {
                [styles.wide_tab_active]: tabProps.tabId == props.selectedTab,
                [styles.wide_tab_disabled]: tabProps.disabled,
            })}
            data-tab={tabProps.tabId}
            onClick={tabProps.disabled ? undefined : selectTab}
        >
            <button className={styles.wide_tab_button}>
                <svg width="18px" height="16px">
                    <use xlinkHref={(tabProps.tabId == props.selectedTab && tabProps.iconActive) ? tabProps.iconActive : tabProps.icon} />
                </svg>
                <div className={styles.wide_tab_label}>{tabProps.labelShort}</div>
            </button>
        </div>
    );
    const tabRenderer = props.variant == VerticalTabVariant.Stacked ? renderStackedTab : renderWideTab;
    return (
        <div className={classNames(props.className, styles.container)}>
            <div className={styles.tabs}>
                {props.tabKeys.map(t => tabRenderer(props.tabProps[t]))}
            </div>
            <div className={styles.body}>{tabBody}</div>
        </div>
    );
};
