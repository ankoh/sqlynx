import * as React from 'react';
import * as styles from './app_settings_view.module.css';

import { XIcon } from '@primer/octicons-react';
import { IconButton } from '@primer/react';
import { Button } from '../view/foundations/button.js';

import { AppConfig, useAppConfig, useAppReconfigure } from '../app_config.js';

export function AppSettings(props: { onClose: () => void; }) {
    const config = useAppConfig();
    const reconfigure = useAppReconfigure();
    const toggleDebugMode = React.useCallback(() => {
        reconfigure({
            map: (value: AppConfig) => ({
                ...value,
                settings: {
                    ...value.settings,
                    interfaceDebugMode: !value.settings?.interfaceDebugMode,
                }
            }),
            reject: (_err: Error) => { }
        });
        props.onClose();
    }, []);
    const interfaceDebugMode = config.value?.settings?.interfaceDebugMode ?? false;
    return (
        <div className={styles.settings_root}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>Internals</div>
                </div>
                <div className={styles.header_right_container}>
                    <IconButton
                        variant="invisible"
                        icon={XIcon}
                        aria-label="close-overlay"
                        onClick={props.onClose}
                    />
                </div>
            </div>
            <div className={styles.internals_container}>
                <div className={styles.settings_container}>
                    <div className={styles.setting_name}>
                        Interface Debug Mode
                    </div>
                    <div className={styles.setting_switch}>
                        <Button onClick={toggleDebugMode}>
                            {interfaceDebugMode ? "Disable" : "Enable"}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
