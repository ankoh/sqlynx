import * as React from 'react';

import type { AttachedDatabaseState } from '../../connections/attached_database_state.js';
import type { SessionScripts } from '../scripts/session_scripts.js';
import * as ActionList from '../../../ui/foundations/action_list.js';
import { ConnectionCommandList } from './session_command_lists.js';
import * as styles from './session_connection_section.module.css';

interface Props {
    conn: AttachedDatabaseState | null;
    sessionScripts: SessionScripts;
    onOpenSettings: (anchor: HTMLButtonElement | null) => void;
    actions: React.ReactElement;
}

export const SessionConnectionSection: React.FC<Props> = (props) => {
    const settingsRef = React.useRef<HTMLButtonElement>(null);
    return (
        <section className={styles.section} aria-label="Attached Database">
            <ActionList.List>
                <ConnectionCommandList
                    conn={props.conn}
                    sessionScripts={props.sessionScripts}
                    onOpenSettings={() => props.onOpenSettings(settingsRef.current)}
                    settingsRef={settingsRef}
                />
                {props.actions}
            </ActionList.List>
        </section>
    );
};
