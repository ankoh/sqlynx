import * as React from 'react';

import { classNames } from '../utils/classnames.js';

import styles from './vertical_tabs.module.css';

export interface VerticalTabRenderers {
    [key: number]: (props: VerticalTabProps) => React.ReactElement;
}

export interface VerticalTabProps {
    tabId: number;
    icon: string;
    labelShort: string;
    labelLong?: string;
    disabled?: boolean;
}

export enum VerticalTabVariant {
    Stacked = 0,
    Wide = 1,
}

interface Props {
    className?: string;
    variant: VerticalTabVariant;
    tabs: VerticalTabProps[];
    tabRenderers: VerticalTabRenderers;
    selectedTab: number;
    selectTab: (tab: number) => void;
}

export const VerticalTabs: React.FC<Props> = (props: Props) => {
    const selectTab = React.useCallback((elem: React.MouseEvent) => {
        const target = elem.currentTarget as HTMLDivElement;
        props.selectTab(Number.parseInt(target.dataset.tab ?? '0'));
    }, []);
    const tabRenderer = props.tabRenderers[props.selectedTab];
    const tabBody = tabRenderer ? tabRenderer(props.tabs[props.selectedTab]) : undefined;

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
                <svg width="18px" height="18px">
                    <use xlinkHref={tabProps.icon} />
                </svg>
            </button>
            <div className={styles.stacked_tab_label}>{tabProps.labelShort}</div>
        </div>
    );

    return (
        <div className={classNames(props.className, styles.container)}>
            <div className={styles.tabs}>
                {props.tabs.map(renderStackedTab)}
            </div>
            <div className={styles.body}>{tabBody}</div>
        </div>
    );
};
