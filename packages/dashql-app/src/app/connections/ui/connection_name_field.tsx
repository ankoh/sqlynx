import * as React from 'react';

import * as styles from './connection_name_field.module.css';

import { NameInput } from '../../../ui/foundations/name_input.js';

/// Should the name field take the focus when it is shown? Set by the overlays that open the settings to rename a connection.
export const CONNECTION_NAME_FOCUS_CTX = React.createContext<boolean>(false);

/// The editable name of a connection, a blank name removes the name
export function ConnectionNameField(props: { name: string | null; onCommit: (name: string) => void }): React.ReactElement {
    const focus = React.useContext(CONNECTION_NAME_FOCUS_CTX);
    const inputRef = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => {
        if (!focus) return;
        // The overlay positions itself before its content can take the focus
        const handle = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(handle);
    }, [focus]);
    return (
        <NameInput
            ref={inputRef}
            className={styles.name_input}
            name={props.name}
            onCommit={props.onCommit}
            ariaLabel="Connection name"
            placeholder="Name this connection"
        />
    );
}
