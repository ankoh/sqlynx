import * as React from 'react';

import { Button, ButtonVariant } from '../../../ui/foundations/button.js';
import { Overlay, OverlaySize } from '../../../ui/foundations/overlay.js';
import type { ConnectionImportChoice, ConnectionImportPlanItem } from '../persistence/session_connection_import.js';
import { connectionParamsLabel } from './connection_label.js';

import * as styles from './session_import_conflict_dialog.module.css';
import * as ownStyles from './session_connection_import_dialog.module.css';

interface Props {
    /// The name of the imported session
    sessionName: string;
    /// The connections of the session that may consolidate with existing connections
    questions: ConnectionImportPlanItem[];
    /// Is the import running?
    busy: boolean;
    /// Import with the chosen connections, keyed by the connection id in the session
    onConfirm: (choices: Map<string, ConnectionImportChoice>) => void;
    /// Abort the import
    onCancel: () => void;
}

/// The value of a choice in the form
function choiceValue(choice: ConnectionImportChoice): string {
    return choice.kind === 'link' ? `link:${choice.connectionId}` : 'separate';
}

/// Ask the user whether imported connections should use existing connections.
/// Using an existing connection keeps settings in one place, the session then shares the connection
/// with every other session that uses it.
export function SessionConnectionImportDialog(props: Props): React.ReactElement {
    const titleId = React.useId();
    const descriptionId = React.useId();
    const dialogRef = React.useRef<HTMLElement>(null);
    const [choices, setChoices] = React.useState(() => new Map<string, ConnectionImportChoice>(props.questions.map(item => [
        item.ref.databaseId,
        item.decision.kind === 'ask' ? { kind: 'link', connectionId: item.decision.candidates[0].id } : { kind: 'separate' },
    ])));
    const cancel = React.useCallback(() => {
        if (!props.busy) props.onCancel();
    }, [props.busy, props.onCancel]);

    return (
        <Overlay centered width={OverlaySize.L} onEscape={cancel} onClickOutside={cancel} initialFocusRef={dialogRef}>
            <section
                ref={dialogRef}
                className={styles.dialog}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                aria-busy={props.busy}
                tabIndex={-1}
            >
                <header className={styles.header}>
                    <h2 id={titleId}>Use existing connections?</h2>
                </header>
                <div className={styles.body}>
                    <p id={descriptionId} className={styles.description}>
                        The session {props.sessionName} uses connections that look like connections you already have.
                        Using an existing connection shares its settings with the sessions that already use it.
                    </p>
                    {props.questions.map(item => {
                        if (item.decision.kind !== 'ask') return null;
                        const current = choices.get(item.ref.databaseId);
                        const name = `connection-${item.ref.databaseId}`;
                        const options: Array<{ choice: ConnectionImportChoice; label: string }> = [
                            ...item.decision.candidates.map(candidate => ({
                                choice: { kind: 'link' as const, connectionId: candidate.id },
                                label: `Use ${connectionParamsLabel(candidate.params)}`,
                            })),
                            { choice: { kind: 'separate' }, label: 'Keep as a new connection' },
                        ];
                        return (
                            <fieldset key={item.ref.databaseId} className={ownStyles.connection} disabled={props.busy}>
                                <legend className={ownStyles.connection_label}>
                                    {connectionParamsLabel(item.ref.params)}
                                    {item.ref.role === 'main' ? '' : ' (attached)'}
                                </legend>
                                {options.map(option => (
                                    <label key={choiceValue(option.choice)} className={ownStyles.option}>
                                        <input
                                            type="radio"
                                            name={name}
                                            value={choiceValue(option.choice)}
                                            checked={current != null && choiceValue(current) === choiceValue(option.choice)}
                                            onChange={() => setChoices(prev => new Map(prev).set(item.ref.databaseId, option.choice))}
                                        />
                                        {option.label}
                                    </label>
                                ))}
                            </fieldset>
                        );
                    })}
                </div>
                <footer className={styles.actions}>
                    <Button disabled={props.busy} onClick={cancel}>Cancel</Button>
                    <Button variant={ButtonVariant.Primary} disabled={props.busy} onClick={() => props.onConfirm(choices)}>
                        Import
                    </Button>
                </footer>
            </section>
        </Overlay>
    );
}
