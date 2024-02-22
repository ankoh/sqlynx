import * as React from 'react';

import { SectionProps, SectionRenderers, SettingsPageNav } from './settings_page_nav.js';

import styles from './settings_page.module.css';
import { ConnectorSettings } from './connector_settings.js';

interface PageProps { }

export const SettingsPage: React.FC<PageProps> = (_props: PageProps) => {
    const [selectedSection, selectSection] = React.useState(0);

    const sections: SectionProps[] = React.useMemo(() => ([
        {
            id: 0,
            label: "Connectors"
        },
        {
            id: 1,
            label: "About"
        }
    ]), []);
    const sectionRenderers: SectionRenderers = React.useMemo(() => ({
        [0]: (_props: {}) => <ConnectorSettings />
    }), []);

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>Settings</div>
                </div>
            </div>
            <SettingsPageNav
                className={styles.body_container}
                sections={sections}
                sectionRenderers={sectionRenderers}
                selectSection={selectSection}
                selectedSection={selectedSection}
            />
        </div >
    );
};
