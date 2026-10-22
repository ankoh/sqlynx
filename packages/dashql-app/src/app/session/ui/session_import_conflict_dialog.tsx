import * as React from 'react';

import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { Button } from '../../../ui/foundations/button.js';
import { OverlaySize } from '../../../ui/foundations/overlay.js';
import { SessionImportCard, type SessionImportCardDependencies } from './session_import_card.js';

import * as styles from './session_import_conflict_dialog.module.css';

interface SessionImportConflictDialogBaseProps {
    sessionName: string;
    sessionUuid: string;
    existingDisplayLocation: string;
    existingIsNative: boolean;
    folderCount: number;
    scriptCount: number;
    busy: boolean;
    onReplace: () => void;
    onCreateNew: () => void;
    onCancel: () => void;
    dependencies?: SessionImportCardDependencies;
}

interface CenteredSessionImportConflictDialogProps extends SessionImportConflictDialogBaseProps {
    mode: 'centered';
}

interface AnchoredSessionImportConflictDialogProps extends SessionImportConflictDialogBaseProps {
    mode: 'anchored';
    anchorRef: React.RefObject<Element | null>;
    returnFocusRef: React.RefObject<HTMLElement | null>;
}

export type SessionImportConflictDialogProps =
    | CenteredSessionImportConflictDialogProps
    | AnchoredSessionImportConflictDialogProps;

interface DialogContentProps extends SessionImportConflictDialogBaseProps {
    dialogRef: React.RefObject<HTMLElement | null>;
}

function DialogContent(props: DialogContentProps) {
    const titleId = React.useId();
    const descriptionId = React.useId();

    return (
        <section
            ref={props.dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            aria-busy={props.busy}
            tabIndex={-1}
        >
            <header className={styles.header}>
                <h2 id={titleId}>Session already exists</h2>
            </header>
            <div className={styles.body}>
                <p id={descriptionId} className={styles.description}>
                    A session with this UUID already exists. Replace it, or create a new session with a different UUID.
                </p>
                <dl className={styles.details}>
                    <div>
                        <dt>Session</dt>
                        <dd>{props.sessionName}</dd>
                    </div>
                    <div>
                        <dt>UUID</dt>
                        <dd className={styles.uuid}>{props.sessionUuid}</dd>
                    </div>
                    <div>
                        <dt>Existing location</dt>
                        <dd className={styles.path}>{props.existingDisplayLocation}</dd>
                    </div>
                </dl>
            </div>
            <footer className={styles.actions}>
                <Button disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
                <Button disabled={props.busy} onClick={props.onReplace}>
                    Replace
                </Button>
                <Button
                    disabled={props.busy}
                    onClick={props.onCreateNew}
                >
                    Create New
                </Button>
            </footer>
        </section>
    );
}

export function SessionImportConflictDialog(props: SessionImportConflictDialogProps) {
    return props.mode === 'centered'
        ? <CenteredConflictCard {...props} />
        : <AnchoredConflictDialog {...props} />;
}

function CenteredConflictCard(props: CenteredSessionImportConflictDialogProps) {
    return (
        <SessionImportCard
            phase="conflict"
            sessionName={props.sessionName}
            sessionUuid={props.sessionUuid}
            existingLocation={props.existingDisplayLocation}
            existingIsNative={props.existingIsNative}
            folderCount={props.folderCount}
            scriptCount={props.scriptCount}
            busy={props.busy}
            onClose={props.onCancel}
            onReplace={props.onReplace}
            onCreateNew={props.onCreateNew}
            dependencies={props.dependencies}
        />
    );
}

function AnchoredConflictDialog(props: AnchoredSessionImportConflictDialogProps) {
    const dialogRef = React.useRef<HTMLElement>(null);
    const cancel = React.useCallback(() => {
        if (!props.busy) props.onCancel();
    }, [props.busy, props.onCancel]);
    const content = (
        <DialogContent
            {...props}
            dialogRef={dialogRef}
        />
    );

    return (
        <AnchoredOverlay
            renderAnchor={null}
            anchorRef={props.anchorRef}
            returnFocusRef={props.returnFocusRef}
            open
            onClose={cancel}
            side={AnchorSide.OutsideBottom}
            align={AnchorAlignment.End}
            width={OverlaySize.L}
            overlayProps={{ initialFocusRef: dialogRef }}
            focusTrapSettings={{
                initialFocusRef: dialogRef as React.RefObject<HTMLElement>,
                returnFocusRef: props.returnFocusRef as React.RefObject<HTMLElement>,
            }}
        >
            {content}
        </AnchoredOverlay>
    );
}
