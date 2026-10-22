import * as React from 'react';
import { XIcon } from '../../../ui/foundations/symbol_icon.js';

import { Portal } from '../../../ui/foundations/portal.js';
import { ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { useOverlay } from '../../../ui/foundations/overlay.js';
import { useFocusTrap } from '../../../ui/foundations/focus.js';
import * as styles from './session_navigation_drawer.module.css';

interface Props {
    open: boolean;
    onClose: () => void;
    returnFocusRef: React.RefObject<HTMLElement | null>;
    children: React.ReactNode;
}

export const SessionNavigationDrawer: React.FC<Props> = (props) => {
    const closeButtonRef = React.useRef<HTMLButtonElement>(null);
    const overlayRef = useOverlay({
        onEscape: props.onClose,
        onClickOutside: props.onClose,
        returnFocusRef: props.returnFocusRef,
        initialFocusRef: closeButtonRef,
    });
    useFocusTrap({
        containerRef: overlayRef as React.RefObject<HTMLElement>,
        initialFocusRef: closeButtonRef as React.RefObject<HTMLElement>,
        disabled: !props.open,
    });

    if (!props.open) return null;
    return (
        <Portal>
            <div>
                <div className={styles.backdrop} aria-hidden="true" />
                <aside ref={overlayRef} className={styles.drawer} role="dialog" aria-modal="true" aria-label="Session workbench">
                    <header className={styles.header}>
                        <IconButton ref={closeButtonRef} variant={ButtonVariant.Invisible} aria-label="Close session workbench" onClick={props.onClose}>
                            <XIcon />
                        </IconButton>
                    </header>
                    <div className={styles.body}>{props.children}</div>
                </aside>
            </div>
        </Portal>
    );
};
