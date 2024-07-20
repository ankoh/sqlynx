import * as React from 'react';
import * as styles from './catalog_viewer.module.css'

import { CatalogRenderingSettings, CatalogRenderingState, layoutCatalog, renderCatalog } from './catalog_renderer.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { observeSize } from '../foundations/size_observer.js';

const RENDERING_SETTINGS: CatalogRenderingSettings = {
    virtual: {
        prerenderSize: 100,
        stepSize: 20,
    },
    levels: {
        databases: {
            nodeWidth: 120,
            nodeHeight: 24,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
        schemas: {
            nodeWidth: 120,
            nodeHeight: 24,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
        tables: {
            nodeWidth: 120,
            nodeHeight: 24,
            maxUnpinnedChildren: 5,
            rowGap: 8,
            columnGap: 48,
        },
        columns: {
            nodeWidth: 120,
            nodeHeight: 24,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
    }
};

interface Props {
}

export function CatalogViewer(props: Props) {
    const [sessionState, _dispatchSession] = useCurrentSessionState();

    // Maintain a catalog snapshot of the session
    const [state, setState] = React.useState<CatalogRenderingState | null>(null);
    React.useEffect(() => {
        const snapshot = sessionState?.connectionCatalog.createSnapshot() ?? null;
        if (snapshot) {
            const state = new CatalogRenderingState(snapshot, RENDERING_SETTINGS);
            setState(state);
        }
    }, [sessionState?.connectionCatalog.snapshot]);


    // Watch the container size
    const containerElement = React.useRef(null);
    const containerSize = observeSize(containerElement);

    // Subscribe to scroll events
    interface VirtualWindow {
        top: number;
        height: number;
    };
    const [scrollPos, setScrollPos] = React.useState<VirtualWindow | null>(null);
    const handleScroll = (e: React.UIEvent<HTMLDivElement, UIEvent>) => {
        const { scrollTop, scrollHeight } = e.target as HTMLDivElement;
        setScrollPos({
            top: scrollTop,
            height: scrollHeight,
        });
    };

    // Derive a virtual window from the scroll position and container size
    const [virtualWindow, setVirtualWindow] = React.useState<VirtualWindow | null>(null);
    React.useEffect(() => {
        // Skip if we don't know the container size yet
        if (!containerSize || !state) {
            return;
        }

        // Did the user scroll?
        if (scrollPos) {
            let lb = Math.floor((scrollPos.top - RENDERING_SETTINGS.virtual.prerenderSize) / RENDERING_SETTINGS.virtual.stepSize) * RENDERING_SETTINGS.virtual.stepSize;
            let ub = Math.ceil((scrollPos.top + containerSize.height + RENDERING_SETTINGS.virtual.prerenderSize) / RENDERING_SETTINGS.virtual.stepSize) * RENDERING_SETTINGS.virtual.stepSize;
            lb = Math.max(lb, 0);
            ub = Math.min(ub, state.totalHeight);
            setVirtualWindow({
                top: lb,
                height: ub - lb
            })
        } else {
            // The user didn't scoll, just render the container
            let ub = Math.ceil((containerSize.height + RENDERING_SETTINGS.virtual.prerenderSize) / RENDERING_SETTINGS.virtual.stepSize) * RENDERING_SETTINGS.virtual.stepSize;
            ub = Math.min(ub, state.totalHeight);
            setVirtualWindow({
                top: 0,
                height: ub
            })
        }
    }, [state, scrollPos, containerSize]);

    // Memo must depend on scroll window and window size
    const nodes = React.useMemo(() => {
        // No state or measured container size?
        if (!state || !virtualWindow) {
            return null;
        }
        // Update the virtual window
        state.updateVirtualWindow(virtualWindow.top, virtualWindow.height);
        // Render the catalog
        return renderCatalog(state);

    }, [state, virtualWindow]);

    return (
        <div className={styles.root}>
            <div className={styles.board_container} ref={containerElement}>
                <div className={styles.board_container} ref={containerElement} onScroll={handleScroll}>
                    <div
                        className={styles.node_layer}
                        style={{
                            width: state?.totalWidth,
                            height: state?.totalHeight,
                        }}
                    >
                        {nodes}
                    </div>
                </div>
            </div>
            <div className={styles.overlay_title}>Schema</div>
        </div>
    );
}
