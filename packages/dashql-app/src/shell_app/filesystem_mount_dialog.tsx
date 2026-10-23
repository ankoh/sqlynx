import * as React from 'react';

import * as ActionList from '../ui/foundations/action_list.js';
import { Button, ButtonSize, ButtonVariant, IconButton } from '../ui/foundations/button.js';
import { useFocusTrap } from '../ui/foundations/focus.js';
import { Overlay, OverlaySize } from '../ui/foundations/overlay.js';
import { FileDirectoryIcon, FileIcon, XIcon } from '../ui/foundations/symbol_icon.js';
import { TextInput } from '../ui/foundations/text_input.js';
import type { PlatformFile } from '../platform/file/file.js';
import * as styles from './filesystem_mount_dialog.module.css';

export interface MountDialogController {
    request(signal?: AbortSignal): Promise<string>;
}

export interface MountDialogHookResult {
    controller: MountDialogController;
    dialog: React.ReactElement | null;
}

export interface MountDialogActions {
    selectFiles(signal?: AbortSignal): Promise<MountSelection | null>;
    selectDirectory(mode: 'read' | 'readwrite', signal?: AbortSignal): Promise<MountSelection | null>;
    mount(selection: MountSelection, path: string | undefined, signal?: AbortSignal): Promise<string>;
}

export type MountSelection = {
    readonly name: string;
    readonly kind: 'file';
    readonly file: PlatformFile;
} | {
    readonly name: string;
    readonly kind: 'directory';
    readonly handle: FileSystemDirectoryHandle;
    readonly mode: 'read' | 'readwrite';
};

interface PendingRequest {
    resolve: (path: string) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

export function useMountDialog(actions: MountDialogActions): MountDialogHookResult {
    const [open, setOpen] = React.useState(false);
    const pendingRef = React.useRef<PendingRequest | null>(null);

    const finish = React.useCallback((result?: { path?: string; error?: unknown }) => {
        const pending = pendingRef.current;
        pendingRef.current = null;
        pending?.signal?.removeEventListener('abort', pending.onAbort!);
        setOpen(false);
        setSelection(null);
        if (result?.error != null) pending?.reject(result.error);
        else pending?.resolve(result?.path ?? 'Mount cancelled');
    }, []);

    const request = React.useCallback((signal?: AbortSignal) => {
        if (pendingRef.current != null) return Promise.reject(new Error('A mount request is already pending.'));
        if (signal?.aborted) return Promise.resolve('Mount cancelled');
        setSelection(null);
        setOpen(true);
        return new Promise<string>((resolve, reject) => {
            const pending: PendingRequest = { resolve, reject, signal };
            pending.onAbort = () => finish();
            pendingRef.current = pending;
            signal?.addEventListener('abort', pending.onAbort, { once: true });
        });
    }, [finish]);

    React.useEffect(() => () => finish(), [finish]);

    const [selection, setSelection] = React.useState<MountSelection | null>(null);
    const select = React.useCallback(async (action: (signal?: AbortSignal) => Promise<MountSelection | null>) => {
        const signal = pendingRef.current?.signal;
        try {
            const next = await action(signal);
            if (next != null) setSelection(next);
        } catch (error) {
            finish({ error });
        }
    }, [finish]);

    const mount = React.useCallback(async (path: string) => {
        if (selection == null) return;
        try {
            finish({ path: await actions.mount(selection, path || undefined, pendingRef.current?.signal) });
        } catch (error) {
            finish({ error });
        }
    }, [actions, finish, selection]);

    const controller = React.useMemo<MountDialogController>(() => ({ request }), [request]);
    return {
        controller,
        dialog: open ? <MountDialog actions={actions} selection={selection} onCancel={finish} onMount={mount} onSelect={select} /> : null,
    };
}

interface MountDialogProps {
    actions: MountDialogActions;
    selection: MountSelection | null;
    onCancel: () => void;
    onMount: (path: string) => void;
    onSelect: (action: (signal?: AbortSignal) => Promise<MountSelection | null>) => void;
}

function MountDialog(props: MountDialogProps) {
    const headingId = React.useId();
    const dialogRef = React.useRef<HTMLElement>(null);
    const pathInputRef = React.useRef<HTMLInputElement>(null);
    const [path, setPath] = React.useState('');
    React.useEffect(() => {
        setPath(props.selection == null ? '' : `/mnt/external/${props.selection.name}`);
    }, [props.selection]);
    useFocusTrap({
        containerRef: dialogRef as React.RefObject<HTMLElement>,
        initialFocusRef: props.selection == null
            ? dialogRef as React.RefObject<HTMLElement>
            : pathInputRef as React.RefObject<HTMLElement>,
        restoreFocusOnCleanUp: true,
    });

    return (
        <Overlay
            centered
            width={OverlaySize.L}
            preventFocusOnOpen
            onEscape={props.onCancel}
            onClickOutside={props.onCancel}
        >
            <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}>
                <header className={styles.header}>
                    <h2 id={headingId}>{props.selection == null ? 'Filesystem Mount' : 'Mount Path'}</h2>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="Close filesystem mount"
                        onClick={props.onCancel}
                    >
                        <XIcon />
                    </IconButton>
                </header>
                {props.selection == null ? <ActionList.List aria-label="Mount type" leading>
                    <ActionList.ListItem onClick={() => props.onSelect(props.actions.selectFiles)}>
                        <ActionList.Leading><FileIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>File</ActionList.ItemText>
                        <ActionList.Trailing><span className={styles.access_mode}>READ</span></ActionList.Trailing>
                    </ActionList.ListItem>
                    <ActionList.ListItem onClick={() => props.onSelect(signal => props.actions.selectDirectory('read', signal))}>
                        <ActionList.Leading><FileDirectoryIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>Folder</ActionList.ItemText>
                        <ActionList.Trailing><span className={styles.access_mode}>READ</span></ActionList.Trailing>
                    </ActionList.ListItem>
                    <ActionList.ListItem onClick={() => props.onSelect(signal => props.actions.selectDirectory('readwrite', signal))}>
                        <ActionList.Leading><FileDirectoryIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>Folder</ActionList.ItemText>
                        <ActionList.Trailing><span className={styles.access_mode}>READ/WRITE</span></ActionList.Trailing>
                    </ActionList.ListItem>
                </ActionList.List> : <form className={styles.path_form} onSubmit={event => {
                    event.preventDefault();
                    props.onMount(path);
                }}>
                    <TextInput
                        ref={pathInputRef}
                        id="mount-path"
                        aria-label="Mount path"
                        block
                        className={styles.mount_path}
                        value={path}
                        onChange={event => setPath(event.target.value)}
                    />
                    <div className={styles.actions}>
                        <Button variant={ButtonVariant.Invisible} onClick={props.onCancel}>Cancel</Button>
                        <Button variant={ButtonVariant.Primary} type="submit">Mount</Button>
                    </div>
                </form>}
            </section>
        </Overlay>
    );
}
