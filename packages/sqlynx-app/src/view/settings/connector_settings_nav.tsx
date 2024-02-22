import * as React from 'react';

import { classNames } from '../../utils/classnames.js';

import styles from './connector_settings_nav.module.css';

export interface ConnectorProps {
    id: number;
    label: string;
}

export interface ConnectorRenderers {
    [key: number]: (props: ConnectorProps) => React.ReactElement;
}

interface Props {
    className?: string;
    connectors: ConnectorProps[];
    connectorRenderers: ConnectorRenderers;
    selectedConnector: number;
    selectConnector: (connector: number) => void;
}

export const ConnectorSettingsNav: React.FC<Props> = (props: Props) => {
    const selectConnector = React.useCallback((elem: React.MouseEvent) => {
        const target = elem.currentTarget as HTMLDivElement;
        props.selectConnector(Number.parseInt(target.dataset.tab ?? '0'));
    }, []);
    const renderer = props.connectorRenderers[props.selectedConnector];
    return (
        <div className={classNames(props.className, styles.layout)}>
            <div className={styles.list}>
                {props.connectors.map((tabProps: ConnectorProps) => (
                    <button
                        key={tabProps.id}
                        className={classNames(styles.entry, {
                            [styles.entry_active]: tabProps.id == props.selectedConnector
                        })}
                        data-tab={tabProps.id}
                        onClick={selectConnector}
                    >
                        {tabProps.label}
                    </button>
                ))}
            </div>
            <div className={styles.body}>{renderer ? renderer(props.connectors[props.selectedConnector]) : undefined}</div>
        </div>
    );
};
