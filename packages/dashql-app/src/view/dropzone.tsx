import * as React from 'react';
import * as styles from './dropzone.module.css';

import { usePlatformEventListener } from '../platform/event_listener_provider.js';
import { DRAG_EVENT, DRAG_STOP_EVENT, DROP_EVENT, PlatformDragDropEventVariant } from '../platform/event.js';

const DROPZONE_TIMEOUT = 100;

export function DropzoneContainer(props: { children: React.ReactElement }) {
    const appEvents = usePlatformEventListener();

    const [dragOngoing, setDragOngoing] = React.useState<Date | null>(null);

    const onDragDrop = React.useCallback((event: PlatformDragDropEventVariant) => {
        switch (event.type) {
            case DRAG_EVENT:
                setDragOngoing(new Date());
                break;
            case DRAG_STOP_EVENT:
            case DROP_EVENT:
                break;
        }
    }, []);

    React.useEffect(() => {
        appEvents.subscribeDragDropEvents("dropzone", onDragDrop);
        return () => appEvents.unsubscribeDragDropEvents("dropzone");
    }, [appEvents, onDragDrop]);


    React.useEffect(() => {
        const clearDragStart = () => {
            setDragOngoing(null);
        };
        const timeoutId = setTimeout(() => clearDragStart(), DROPZONE_TIMEOUT);
        return () => clearTimeout(timeoutId);
    }, [dragOngoing]);


    return (
        <div className={styles.root}>
            {dragOngoing ? <div /> : props.children}
        </div>
    );
}
