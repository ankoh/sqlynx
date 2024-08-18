import * as React from 'react';
import * as styles from './catalog_viewer.module.css'

import { renderCatalog } from './catalog_renderer.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { observeSize } from '../foundations/size_observer.js';
import { EdgeLayer } from './edge_layer.js';
import { NodeLayer } from './node_layer.js';
import { useThrottledMemo } from '../../utils/throttle.js';
import { CatalogRenderingSettings, CatalogViewModel } from './catalog_view_model.js';
import { ScriptKey } from '../../session/session_state.js';

const RENDERING_SETTINGS: CatalogRenderingSettings = {
    virtual: {
        prerenderSize: 200,
        stepSize: 1,
    },
    levels: {
        databases: {
            nodeWidth: 160,
            nodeHeight: 30,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
        schemas: {
            nodeWidth: 160,
            nodeHeight: 30,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
        tables: {
            nodeWidth: 160,
            nodeHeight: 30,
            maxUnpinnedChildren: 5,
            rowGap: 16,
            columnGap: 48,
        },
        columns: {
            nodeWidth: 160,
            nodeHeight: 30,
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
    const [viewModel, setViewModel] = React.useState<CatalogViewModel | null>(null);
    const [viewModelVersion, setViewModelVersion] = React.useState<number>(0);
    React.useEffect(() => {
        const snapshot = sessionState?.connectionCatalog.createSnapshot() ?? null;
        if (snapshot) {
            const state = new CatalogViewModel(snapshot, RENDERING_SETTINGS);
            setViewModel(state);
        }
    }, [sessionState?.connectionCatalog.snapshot]);

    // Load script refs
    React.useEffect(() => {
        const script = sessionState?.scripts[ScriptKey.MAIN_SCRIPT] ?? null;
        if (viewModel != null && script != null && script.processed.analyzed != null) {
            console.log("PIN SCRIPT REFS");
            const analyzed = script.processed.analyzed.read();
            viewModel.pinScriptRefs(analyzed);
            setViewModelVersion(v => v + 1);
        }

    }, [viewModel, sessionState?.scripts[ScriptKey.MAIN_SCRIPT]]);


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
        if (!containerSize || !viewModel) {
            return;
        }

        // Did the user scroll?
        if (scrollTop) {
            let lb = Math.floor((scrollTop - RENDERING_SETTINGS.virtual.prerenderSize) / RENDERING_SETTINGS.virtual.stepSize) * RENDERING_SETTINGS.virtual.stepSize;
            let ub = Math.ceil((scrollTop + containerSize.height + RENDERING_SETTINGS.virtual.prerenderSize) / RENDERING_SETTINGS.virtual.stepSize) * RENDERING_SETTINGS.virtual.stepSize;
            lb = Math.max(lb, 0);
            ub = Math.min(ub, viewModel.totalHeight);
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
            ub = Math.min(ub, viewModel.totalHeight);
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
    }, [viewModel, scrollTop, containerSize]);

    // Memo must depend on scroll window and window size
    const [nodes, edges] = React.useMemo(() => {
        // No state or measured container size?
        if (!viewModel || !renderingWindow) {
            return [null, null];
        }
        // Update the virtual window
        viewModel.updateWindow(
            renderingWindow.scroll.top,
            renderingWindow.scroll.top + renderingWindow.scroll.height,
            renderingWindow.virtual.top,
            renderingWindow.virtual.top + renderingWindow.virtual.height
        );
        console.log("UPDATE")
        // Render the catalog
        const outNodes: React.ReactElement[] = [];
        const outEdges: React.ReactElement[] = [];
        renderCatalog(viewModel, outNodes, outEdges);
        return [outNodes, outEdges];

    }, [viewModelVersion, renderingWindow]);

    return (
        <div className={styles.root}>
            <div className={styles.board_container} ref={containerElement}>
                <div className={styles.board_container} ref={containerElement} onScroll={handleScroll}>
                    <div className={styles.board}>
                        <EdgeLayer
                            width={viewModel?.totalWidth ?? 0}
                            height={viewModel?.totalHeight ?? 0}
                            padding={padding}
                            paths={edges ?? []}
                        />
                        <NodeLayer
                            width={viewModel?.totalWidth ?? 0}
                            height={viewModel?.totalHeight ?? 0}
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
