import * as React from 'react';
import cn from 'classnames';

import styles from './tab_card.module.css';

interface TabProps {}

interface TabRenderers {
    [key: number]: (props: TabProps) => React.ReactElement;
}

interface Props {
    className?: string;
    tabs: [number, string][];
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
                {props.tabs.map((tab: [number, string]) => (
                    <div
                        key={tab[0]}
                        className={cn(styles.tab, {
                            [styles.tab_active]: tab[0] == props.selectedTab,
                        })}
                        data-tab={tab[0]}
                        onClick={selectTab}
                    >
                        <svg width="20px" height="20px">
                            <use xlinkHref={tab[1]} />
                        </svg>
                    </div>
                ))}
            </div>
            <div className={styles.body}>{props.tabRenderers[props.selectedTab](props.tabProps)}</div>
        </div>
    );
};
