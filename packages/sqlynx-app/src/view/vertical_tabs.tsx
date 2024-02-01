import * as React from 'react';
import cn from 'classnames';

import styles from './vertical_tabs.module.css';

interface TabRenderers {
    [key: number]: (props: TabProps) => React.ReactElement;
}

interface TabProps {
    tabId: number;
    icon: string;
    label: string;
    enabled: boolean;
}

interface Props {
    className?: string;
    tabs: TabProps[];
    tabRenderers: TabRenderers;
    selectedTab: number;
    selectTab: (tab: number) => void;
}

export const VerticalTabs: React.FC<Props> = (props: Props) => {
    const selectTab = React.useCallback((elem: React.MouseEvent) => {
        const target = elem.currentTarget as HTMLDivElement;
        props.selectTab(Number.parseInt(target.dataset.tab ?? '0'));
    }, []);
    return (
        <div className={cn(props.className, styles.container)}>
            <div className={styles.tabs}>
                {props.tabs.map((tabProps: TabProps) => (
                    <div
                        key={tabProps.tabId}
                        className={cn(styles.tab, {
                            [styles.tab_active]: tabProps.tabId == props.selectedTab,
                            [styles.tab_disabled]: !tabProps.enabled,
                        })}
                        data-tab={tabProps.tabId}
                        onClick={tabProps.enabled ? selectTab : undefined}
                    >
                        <div className={styles.tab_icon}>
                            <svg width="20px" height="20px">
                                <use xlinkHref={tabProps.icon} />
                            </svg>
                        </div>
                        <div className={styles.tab_label}>{tabProps.label}</div>
                    </div>
                ))}
            </div>
            <div className={styles.body}>{props.tabRenderers[props.selectedTab](props.tabs[props.selectedTab])}</div>
        </div>
    );
};
