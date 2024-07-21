import * as React from 'react';
import * as styles from './catalog_viewer.module.css'

import { CatalogRenderingSettings, CatalogRenderingState, renderCatalog } from './catalog_renderer.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { observeSize } from '../foundations/size_observer.js';
import { EdgeLayer } from './edge_layer.js';
import { NodeLayer } from './node_layer.js';
import { useThrottledMemo } from '../../utils/throttle.js';

const RENDERING_SETTINGS: CatalogRenderingSettings = {
    virtual: {
        prerenderSize: 100,
        stepSize: 10,
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
            rowGap: 16,
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
    const padding = 20;

    // Subscribe to scroll events
    interface Range {
        top: number;
        height: number;
    };
    interface RenderingWindow {
        scroll: Range;
        virtual: Range;
    };
    const [scrollTopRaw, setScrollTop] = React.useState<number | null>(null);
    const handleScroll = (e: React.UIEvent<HTMLDivElement, UIEvent>) => {
        const scrollTop = (e.target as HTMLDivElement).scrollTop;
        setScrollTop(Math.max(scrollTop, padding) - padding);
    };
    const scrollTop = useThrottledMemo(scrollTopRaw, [scrollTopRaw], 30);

    // Derive a virtual window from the scroll position and container size
    const [renderingWindow, setRenderingWindow] = React.useState<RenderingWindow | null>(null);
    React.useEffect(() => {
        // Skip if we don't know the container size yet
        if (!containerSize || !state) {
            return;
        }

        // Did the user scroll?
        if (scrollTop) {
            let lb = Math.floor((scrollTop - RENDERING_SETTINGS.virtual.prerenderSize) / RENDERING_SETTINGS.virtual.stepSize) * RENDERING_SETTINGS.virtual.stepSize;
            let ub = Math.ceil((scrollTop + containerSize.height + RENDERING_SETTINGS.virtual.prerenderSize) / RENDERING_SETTINGS.virtual.stepSize) * RENDERING_SETTINGS.virtual.stepSize;
            lb = Math.max(lb, 0);
            ub = Math.min(ub, state.totalHeight);
            setRenderingWindow({
                scroll: {
                    top: scrollTop,
                    // Make sure we respect the top padding when computing the scroll window.
                    // When we're on the "first page", we have to subtract the top padding from the container height.
                    height: Math.max(containerSize.height - padding + Math.min(scrollTop, padding), 0)
                },
                virtual: {
                    top: lb,
                    height: ub - lb
                }
            });
        } else {
            // The user didn't scoll, just render the container
            let ub = Math.ceil((containerSize.height + RENDERING_SETTINGS.virtual.prerenderSize) / RENDERING_SETTINGS.virtual.stepSize) * RENDERING_SETTINGS.virtual.stepSize;
            ub = Math.min(ub, state.totalHeight);
            setRenderingWindow({
                scroll: {
                    top: 0,
                    height: Math.max(containerSize.height, padding) - padding
                },
                virtual: {
                    top: 0,
                    height: ub
                }
            })
        }
    }, [state, scrollTop, containerSize]);

    // Memo must depend on scroll window and window size
    const [nodes, edges] = React.useMemo(() => {
        // No state or measured container size?
        if (!state || !renderingWindow) {
            return [null, null];
        }
        // Update the virtual window
        state.currentRenderingWindow.updateWindow(
            renderingWindow.scroll.top,
            renderingWindow.scroll.top + renderingWindow.scroll.height,
            renderingWindow.virtual.top,
            renderingWindow.virtual.top + renderingWindow.virtual.height
        );
        // Render the catalog
        const outNodes: React.ReactElement[] = [];
        const outEdges: string[] = [];
        renderCatalog(state, outNodes, outEdges);
        return [outNodes, outEdges];

    }, [state, renderingWindow]);

    return (
        <div className={styles.root}>
            <div className={styles.board_container} ref={containerElement}>
                <div className={styles.board_container} ref={containerElement} onScroll={handleScroll}>
                    <div className={styles.board}>
                        <EdgeLayer
                            width={state?.totalWidth ?? 0}
                            height={state?.totalHeight ?? 0}
                            padding={padding}
                            paths={edges ?? []}
                        />
                        <NodeLayer
                            width={state?.totalWidth ?? 0}
                            height={state?.totalHeight ?? 0}
                            padding={padding}
                            nodes={nodes ?? []}
                        />
                    </div>
                </div>
            </div>
            <div className={styles.overlay_title}>Schema</div>
        </div>
    );
}
