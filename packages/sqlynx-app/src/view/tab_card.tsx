import * as React from 'react';
import cn from 'classnames';

import styles from './tab_card.module.css';

interface TabProps {}

interface TabRenderers {
    [key: number]: (props: TabProps) => React.ReactElement;
}

interface Props {
    tabs: [number, URL][];
    tabRenderers: TabRenderers;
    tabProps: TabProps;
    selectedTab: number;
}

export const TabCard: React.FC<Props> = (props: Props) => {
    return (
        <div className={styles.container}>
            <div className={styles.tabs}>
                {props.tabs.map((tab: [number, URL]) => (
                    <div
                        key={tab[0]}
                        className={cn(styles.tab, {
                            [styles.tab_active]: tab[0] == props.selectedTab,
                        })}
                    >
                        <svg width="20px" height="20px">
                            <use xlinkHref={`${tab[1]}#sym`} />
                        </svg>
                    </div>
                ))}
            </div>
            <div className={styles.body}>{props.tabRenderers[props.selectedTab](props.tabProps)}</div>
        </div>
    );
};
