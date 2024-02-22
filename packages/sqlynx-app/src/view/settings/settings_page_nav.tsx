import * as React from 'react';

import { classNames } from '../../utils/classnames.js';

import styles from './settings_page_nav.module.css';

export interface SectionProps {
    id: number;
    label: string;
}

export interface SectionRenderers {
    [key: number]: (props: SectionProps) => React.ReactElement;
}

interface Props {
    className?: string;
    sections: SectionProps[];
    sectionRenderers: SectionRenderers;
    selectedSection: number;
    selectSection: (section: number) => void;
}

export const SettingsPageNav: React.FC<Props> = (props: Props) => {
    const selectSection = React.useCallback((elem: React.MouseEvent) => {
        const target = elem.currentTarget as HTMLDivElement;
        props.selectSection(Number.parseInt(target.dataset.tab ?? '0'));
    }, []);
    const renderer = props.sectionRenderers[props.selectedSection];
    return (
        <div className={classNames(props.className, styles.layout)}>
            <div className={styles.list}>
                {props.sections.map((tabProps: SectionProps) => (
                    <div
                        key={tabProps.id}
                        className={classNames(styles.entry, {
                            [styles.entry_active]: tabProps.id == props.selectedSection
                        })}
                        data-tab={tabProps.id}
                        onClick={selectSection}
                    >
                        <div className={styles.entry_label}>{tabProps.label}</div>
                    </div>
                ))}
            </div>
            <div className={styles.body}>{renderer ? renderer(props.sections[props.selectedSection]) : undefined}</div>
        </div>
    );
};
