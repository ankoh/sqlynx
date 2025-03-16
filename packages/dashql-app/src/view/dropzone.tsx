import * as React from 'react';
import * as styles from './dropzone.module.css';

import { usePlatformEventListener } from '../platform/event_listener_provider.js';
import { DRAG_EVENT, DRAG_STOP_EVENT, DROP_EVENT, PlatformDragDropEventVariant } from '../platform/event.js';

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
            case DROP_EVENT:
                setDragOngoing(null);
                break;
        }
    }, []);

    // Subscribe drag/drop events
    React.useEffect(() => {
        appEvents.subscribeDragDropEvents("dropzone", onDragDrop);
        return () => appEvents.unsubscribeDragDropEvents("dropzone");
    }, [appEvents, onDragDrop]);

    return (
        <div className={styles.root}>
            {dragOngoing ? <div /> : props.children}
        </div>
    );
}
