import * as React from 'react';

import { classNames } from '../../utils/classnames.js';

import styles from './settings_connection_list.module.css';

interface SectionProps {
    sectionId: number;
    label: string;
    enabled: boolean;
}

interface SectionRenderers {
    [key: number]: (props: SectionProps) => React.ReactElement;
}

interface Props {
    className?: string;
    sections: SectionProps[];
    sectionRenderers: SectionRenderers;
    selectedSection: number;
    selectSection: (section: number) => void;
}

export const SettingsSectionList: React.FC<Props> = (props: Props) => {
    const selectSection = React.useCallback((elem: React.MouseEvent) => {
        const target = elem.currentTarget as HTMLDivElement;
        props.selectSection(Number.parseInt(target.dataset.tab ?? '0'));
    }, []);
    return (
        <div className={classNames(props.className, styles.section_list_layout)}>
            <div className={styles.section_list_entries}>
                {props.sections.map((tabProps: SectionProps) => (
                    <div
                        key={tabProps.sectionId}
                        className={classNames(styles.section_list_entry, {
                            [styles.tab_active]: tabProps.sectionId == props.selectedSection,
                            [styles.tab_disabled]: !tabProps.enabled,
                        })}
                        data-tab={tabProps.sectionId}
                        onClick={tabProps.enabled ? selectSection : undefined}
                    >
                        <div className={styles.tab_label}>{tabProps.label}</div>
                    </div>
                ))}
            </div>
            <div className={styles.section_list_body}>{props.sectionRenderers[props.selectedSection](props.sections[props.selectedSection])}</div>
        </div>
    );
};
