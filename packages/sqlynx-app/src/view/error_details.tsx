import * as React from 'react';
import * as styles from './error_details.module.css';

import { XIcon } from '@primer/octicons-react';
import { IconButton } from '@primer/react';

import { AnchoredOverlay } from './foundations/anchored_overlay.js';
import { DetailedError } from 'utils/error.js';
import { Button, ButtonSize, ButtonVariant } from './foundations/button.js';
import { OverlaySize } from './foundations/overlay.js';

interface ErrorDetailsViewerProps {
    onClose: () => void;
    error: DetailedError
}

export const ErrorDetailsViewer: React.FC<ErrorDetailsViewerProps> = (props: ErrorDetailsViewerProps) => {

    const detailEntries = [];
    for (const k in props.error.details) {
        const v = props.error.details[k];
        detailEntries.push(
            <span className={styles.error_details_entry_key}>
                {k}
            </span>
        );
        detailEntries.push(
            <span className={styles.error_details_entry_value}>
                {v}
            </span>
        );
    }

    return (
        <div className={styles.overlay}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>Error</div>
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
            <div className={styles.error_container}>
                <span className={styles.error_message_label}>
                    Message
                </span>
                <span className={styles.error_message_text}>
                    {props.error.message}
                </span>
                {detailEntries.length > 0 && (
                    <>
                        <span className={styles.error_details_label}>
                            Details
                        </span>
                        <div className={styles.error_details_entries}>
                            {detailEntries}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export type ErrorDetailsButtonProps = {
    className?: string;
    error: DetailedError;
}
export function ErrorDetailsButton(props: ErrorDetailsButtonProps) {
    const [isOpen, setIsOpen] = React.useState<boolean>(false);
    const close = React.useCallback(() => setIsOpen(false), []);
    const button = React.useMemo(() => (
        <Button
            className={props.className}
            onClick={() => setIsOpen(true)}
            variant={ButtonVariant.Invisible}
            size={ButtonSize.Small}
        >
            Error
        </Button>
    ), [props.className]);
    return (
        <AnchoredOverlay
            open={isOpen}
            onClose={close}
            renderAnchor={(p: object) => <div {...p}>{button}</div>}
            width={OverlaySize.M}
        >
            <ErrorDetailsViewer onClose={close} error={props.error} />
        </AnchoredOverlay>
    );
}
