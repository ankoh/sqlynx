import * as React from 'react';
import * as styles from './session_storage_overlay.module.css';

import { XIcon, FileDirectoryIcon } from '../../../../ui/foundations/symbol_icon.js';

import { AnchorAlignment, AnchorSide } from '../../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../../ui/foundations/anchored_overlay.js';
import { ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { OverlaySize } from '../../../../ui/foundations/overlay.js';
import { PlatformType, usePlatformType } from '../../../../platform/platform_type.js';
import { StorageBackendType } from '../../../storage/storage_backend.js';
import { CompositeStorageBackend } from '../../../storage/composite_storage_backend.js';
import { displayPath } from '../../../storage/session_locator.js';
import { useStorageReader, useStorageWriter } from '../../../storage/storage_provider.js';
import { useLogger } from '../../../../platform/logger/logger_provider.js';
import { relocateSessionToNative } from '../storage_migration_flow.js';
import { useSessionScripts } from '../../scripts/session_scripts_registry.js';
import { RENAME_SESSION } from '../../scripts/session_scripts.js';

/// The shared header for the storage view: title on the left, actions + close button on the right.
function StorageViewHeader(props: {
    onClose: () => void;
    canRelocate?: boolean;
    migrating?: boolean;
    onRelocate?: () => void;
}) {
    return (
        <div className={styles.header_container}>
            <div className={styles.header_left_container}>
                <div className={styles.title}>Session Storage</div>
            </div>
            <div className={styles.header_right_container}>
                {props.canRelocate && (
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="Store locally"
                        disabled={props.migrating}
                        onClick={props.onRelocate}
                    >
                        <FileDirectoryIcon />
                    </IconButton>
                )}
                <IconButton
                    variant={ButtonVariant.Invisible}
                    aria-label="close-overlay"
                    onClick={props.onClose}
                >
                    <XIcon />
                </IconButton>
            </div>
        </div>
    );
}

/// A single parameter row (label + monospace value).
function ParamRow(props: { label: string; value: string }) {
    return (
        <div className={styles.param_row}>
            <div className={styles.param_label}>{props.label}</div>
            <div className={styles.param_value} title={props.value}>{props.value}</div>
        </div>
    );
}

/// An editable session-name row. The input owns its draft so typing does not rerender the storage
/// view; blur or Enter dispatches RENAME_SESSION, which normalises blank input to "no name".
export function NameRow(props: { name: string | null; onCommit: (name: string) => void }) {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const cancelBlurRef = React.useRef(false);
    // Re-sync the draft when the persisted name changes (e.g. a rename from elsewhere, or switching
    // sessions while the overlay stays mounted).
    React.useEffect(() => {
        if (inputRef.current != null) inputRef.current.value = props.name ?? '';
    }, [props.name]);

    const commit = React.useCallback((e: React.FocusEvent<HTMLInputElement>) => {
        if (cancelBlurRef.current) {
            cancelBlurRef.current = false;
            return;
        }
        props.onCommit(e.currentTarget.value);
    }, [props.onCommit]);
    const onKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.currentTarget.blur();
        } else if (e.key === 'Escape') {
            // Abandon the edit: restore the persisted value and drop focus.
            cancelBlurRef.current = true;
            e.currentTarget.value = props.name ?? '';
            e.currentTarget.blur();
        }
        e.stopPropagation();
    }, [props.name]);
    const onPointerDown = React.useCallback((e: React.PointerEvent<HTMLInputElement>) => {
        // The overlay is portaled from a sortable session row. Keep selection gestures from
        // bubbling through the React tree and activating that row's drag sensor.
        e.stopPropagation();
    }, []);

    return (
        <input
            ref={inputRef}
            className={styles.name_input}
            type="text"
            aria-label="Session name"
            defaultValue={props.name ?? ''}
            placeholder="Name this session"
            spellCheck={false}
            onBlur={commit}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
        />
    );
}

interface SessionStorageViewerProps {
    sessionId: string | null;
    onClose: () => void;
}

export const SessionStorageViewer: React.FC<SessionStorageViewerProps> = (props) => {
    const reader = useStorageReader();
    const writer = useStorageWriter();
    const logger = useLogger();
    const platform = usePlatformType();

    const [sessionScripts, modifySessionScripts] = useSessionScripts(props.sessionId);
    const onRename = React.useCallback((name: string) => {
        void modifySessionScripts({ type: RENAME_SESSION, value: name });
    }, [modifySessionScripts]);

    const [migrating, setMigrating] = React.useState(false);

    const location = props.sessionId ? reader.getSessionLocation(props.sessionId) : null;
    const isNative = location?.type === StorageBackendType.Native;
    const canRelocate =
        platform === PlatformType.MACOS &&
        !isNative &&
        props.sessionId != null &&
        reader.backend instanceof CompositeStorageBackend;

    const onRelocate = React.useCallback(async () => {
        if (props.sessionId == null || !(reader.backend instanceof CompositeStorageBackend)) return;
        setMigrating(true);
        try {
            await relocateSessionToNative(props.sessionId, reader.backend, writer, logger);
        } catch {
            setMigrating(false);
        }
    }, [props.sessionId, reader.backend, writer, logger]);

    const backendValue = isNative ? 'Host File System' : 'Origin Private File System (Browser)';
    const schemaValue = props.sessionId && location ? displayPath(props.sessionId, location) : '';

    return (
        <div className={styles.body}>
            <StorageViewHeader
                onClose={props.onClose}
                canRelocate={canRelocate}
                migrating={migrating}
                onRelocate={onRelocate}
            />
            <div className={styles.body_content}>
                {sessionScripts && <NameRow name={sessionScripts.name} onCommit={onRename} />}
                <ParamRow label="Backend" value={backendValue} />
                <ParamRow label="Location" value={schemaValue} />
                {isNative && location?.nativePath && (
                    <ParamRow label="Folder" value={location.nativePath} />
                )}
            </div>
        </div>
    );
};

type SessionStorageOverlayProps = {
    sessionId: string | null;
    isOpen: boolean;
    onOpen?: () => void;
    onClose: () => void;
    renderAnchor: (p: object) => React.ReactElement;
    side?: AnchorSide;
    align?: AnchorAlignment;
    anchorOffset?: number;
};

export function SessionStorageOverlay(props: SessionStorageOverlayProps) {
    return (
        <AnchoredOverlay
            open={props.isOpen}
            onOpen={props.onOpen}
            onClose={props.onClose}
            renderAnchor={props.renderAnchor}
            side={props.side}
            align={props.align}
            anchorOffset={props.anchorOffset}
            overlayProps={{
                width: OverlaySize.L,
                height: OverlaySize.S,
            }}
        >
            <SessionStorageViewer sessionId={props.sessionId} onClose={props.onClose} />
        </AnchoredOverlay>
    );
}
