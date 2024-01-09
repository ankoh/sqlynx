import * as React from 'react';
import cn from 'classnames';

import styles from './tab_card.module.css';

interface TabProps {}

interface TabRenderers {
    [key: number]: (props: TabProps) => React.ReactElement;
}

interface Props {
    className?: string;
    tabs: [number, string, boolean][];
    tabRenderers: TabRenderers;
    tabProps: TabProps;
    selectedTab: number;
    selectTab: (tab: number) => void;
}

export const TabCard: React.FC<Props> = (props: Props) => {
    const selectTab = React.useCallback((elem: React.MouseEvent) => {
        const target = elem.currentTarget as HTMLDivElement;
        props.selectTab(Number.parseInt(target.dataset.tab ?? '0'));
    }, []);
    return (
        <div className={cn(props.className, styles.container)}>
            <div className={styles.tabs}>
                {props.tabs.map(([tabId, tabIcon, tabEnabled]: [number, string, boolean]) => (
                    <div
                        key={tabId}
                        className={cn(styles.tab, {
                            [styles.tab_active]: tabId == props.selectedTab,
                            [styles.tab_disabled]: !tabEnabled,
                        })}
                        data-tab={tabId}
                        onClick={tabEnabled ? selectTab : undefined}
                    >
                        <svg width="20px" height="20px">
                            <use xlinkHref={tabIcon} />
                        </svg>
                    </div>
                ))}
            </div>
            <div className={styles.body}>{props.tabRenderers[props.selectedTab](props.tabProps)}</div>
        </div>
    );
};
