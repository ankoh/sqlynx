import * as pb from '@ankoh/dashql-protobuf';
import * as React from 'react';
import * as styles from './file_dropzone.module.css';
import * as symbols from '../../static/svg/symbols.generated.svg';
import * as zstd from '../utils/zstd.js';

import { DRAG_EVENT, DRAG_STOP_EVENT, DROP_EVENT, PlatformDragDropEventVariant } from '../platform/event.js';
import { PlatformFile } from '../platform/file.js';
import { usePlatformEventListener } from '../platform/event_listener_provider.js';
import { useLogger } from '../platform/logger_provider.js';

function FileDropzoneArea() {
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

export function FileDropzone(props: { children: React.ReactElement }) {
    const _logger = useLogger();
    const appEvents = usePlatformEventListener();
    const [dragOngoing, setDragOngoing] = React.useState<Date | null>(null);

    // Callback to drop file
    const onDropFile = React.useCallback(async (file: PlatformFile) => {
        try {
            const fileBuffer = await file.readAsArrayBuffer();
            await zstd.init();
            const fileDecompressed = zstd.decompress(fileBuffer);
            const fileProto = pb.dashql.file.File.fromBinary(fileDecompressed);

            // XXX
            console.log(`read bytes: ${fileBuffer.byteLength}, decompressed: ${fileDecompressed.byteLength}`);
            console.log(fileProto);
        } catch (e: any) {
            console.log(e);
        }
        setDragOngoing(null);
    }, []);

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
                onDropFile(event.value.file);
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
            {dragOngoing ? <FileDropzoneArea /> : props.children}
        </div>
    );
}
