import * as React from 'react';
import * as styles from './dropzone.module.css';
import * as symbols from '../../static/svg/symbols.generated.svg';

import { DRAG_EVENT, DRAG_STOP_EVENT, DROP_EVENT, PlatformDragDropEventVariant } from '../platform/event.js';
import { PlatformFile } from '../platform/file.js';
import { usePlatformEventListener } from '../platform/event_listener_provider.js';

function DropzoneArea() {
    return (
        <div className={styles.area_centered}>
            <div className={styles.area_container}>
                <div className={styles.area_logo}>
                    <svg width="180px" height="180px">
                        <use xlinkHref={`${symbols}#dashql`} />
                    </svg>
                </div>
            </div>
        </div>
    );
}

async function onDropFile(file: PlatformFile, setDragOngoing: React.Dispatch<React.SetStateAction<Date | null>>) {
    const fileBuffer = await file.readAsArrayBuffer();
    // XXX
    console.log(`read bytes: ${fileBuffer.byteLength}`);

    setDragOngoing(null);
}

export function DropzoneContainer(props: { children: React.ReactElement }) {
    const appEvents = usePlatformEventListener();
    const [dragOngoing, setDragOngoing] = React.useState<Date | null>(null);

    // Callback for drag/drop events
    const onDragDrop = React.useCallback((event: PlatformDragDropEventVariant) => {
        switch (event.type) {
            case DRAG_EVENT:
                setDragOngoing(new Date());
                break;
            case DRAG_STOP_EVENT:
                setDragOngoing(null);
                break;
            case DROP_EVENT: {
                onDropFile(event.value.file, setDragOngoing);
                break;
            }
        }
    }, []);

    // Subscribe drag/drop events
    React.useEffect(() => {
        appEvents.subscribeDragDropEvents("dropzone", onDragDrop);
        return () => appEvents.unsubscribeDragDropEvents("dropzone");
    }, [appEvents, onDragDrop]);

    return (
        <div className={styles.root}>
            {dragOngoing ? <DropzoneArea /> : props.children}
        </div>
    );
}
