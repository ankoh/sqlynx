import * as React from 'react';
import * as styles from './catalog_viewer.module.css'

import { renderCatalog } from './catalog_renderer.js';
import { useCurrentWorkbookState } from '../../workbook/current_workbook.js';
import { observeSize } from '../foundations/size_observer.js';
import { EdgeLayer } from './edge_layer.js';
import { NodeLayer } from './node_layer.js';
import { useThrottledMemo } from '../../utils/throttle.js';
import { CatalogRenderingSettings, CatalogViewModel } from './catalog_view_model.js';

const RENDERING_SETTINGS: CatalogRenderingSettings = {
    virtual: {
        prerenderSize: 200,
        stepSize: 1,
    },
    levels: {
        databases: {
            nodeWidth: 160,
            nodeHeight: 36,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
        schemas: {
            nodeWidth: 160,
            nodeHeight: 36,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
        tables: {
            nodeWidth: 160,
            nodeHeight: 36,
            maxUnpinnedChildren: 5,
            rowGap: 24,
            columnGap: 48,
        },
        columns: {
            nodeWidth: 160,
            nodeHeight: 36,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
    }
};

interface Props {
}

export function CatalogViewer(_props: Props) {
    const [workbookState, _dispatchWorkbook] = useCurrentWorkbookState();

    const workloadEntry = workbookState?.workbookEntries[workbookState.selectedWorkbookEntry];
    const script = workloadEntry ? workbookState.scripts[workloadEntry.scriptKey] : null;

    // Watch the container size
    const containerElement = React.useRef(null);
    const containerSize = observeSize(containerElement);
    const padding = 20;

    // Maintain a catalog snapshot of the workbook
    const [viewModel, setViewModel] = React.useState<CatalogViewModel | null>(null);
    const [viewModelVersion, setViewModelVersion] = React.useState<number>(0);
    React.useEffect(() => {
        const snapshot = workbookState?.connectionCatalog.createSnapshot() ?? null;
        if (snapshot) {
            const state = new CatalogViewModel(snapshot, RENDERING_SETTINGS);
            setViewModel(state);
        }
    }, [workbookState?.connectionCatalog.snapshot]);

    // Load script refs
    React.useEffect(() => {
        if (!script) {
            return;
        }
        if (viewModel != null && script.processed.analyzed != null) {
            const analyzed = script.processed.analyzed.read();
            viewModel.pinScriptRefs(analyzed);
            setViewModelVersion(v => v + 1);
        }

    }, [viewModel, script?.processed]);

    // Update user focus
    React.useEffect(() => {
        if (viewModel != null && workbookState?.userFocus) {
            // Pin focused elements
            viewModel.pinFocusedByUser(workbookState.userFocus);

            // Scroll to first focused entry
            let [scrollToFocus, found] = viewModel.getOffsetOfFirstFocused();
            if (found && containerElement.current != null && containerSize != null) {
                const divElem = containerElement.current as HTMLDivElement;
                const clientVerticalCenter = containerSize.height / 2;
                scrollToFocus = Math.max(scrollToFocus, clientVerticalCenter) - clientVerticalCenter; // XXX Padding

                divElem.scrollTop = scrollToFocus;
            }

            setViewModelVersion(v => v + 1);
        }
    }, [viewModel, workbookState?.userFocus]);

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
    const scrollTop = useThrottledMemo(scrollTopRaw, [scrollTopRaw], 10);

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
    const [nodes, edges, edgesFocused] = React.useMemo(() => {
        // No state or measured container size?
        if (!viewModel || !renderingWindow) {
            return [null, null, null];
        }
        // Update the virtual window
        viewModel.updateWindow(
            renderingWindow.scroll.top,
            renderingWindow.scroll.top + renderingWindow.scroll.height,
            renderingWindow.virtual.top,
            renderingWindow.virtual.top + renderingWindow.virtual.height
        );
        // Render the catalog
        const outNodes: React.ReactElement[] = [];
        const outEdges: React.ReactElement[] = [];
        const outEdgesFocused: React.ReactElement[] = [];
        renderCatalog(viewModel, outNodes, outEdges, outEdgesFocused);
        return [outNodes, outEdges, outEdgesFocused];

    }, [viewModelVersion, renderingWindow]);

    let totalWidth = viewModel?.totalWidth ?? 0;
    if (totalWidth == 0) {
        totalWidth = containerSize?.width ?? 0;
    }
    let totalHeight = viewModel?.totalHeight ?? 0;
    if (totalHeight == 0) {
        totalHeight = containerSize?.height ?? 0;
    }
    return (
        <div className={styles.root}>
            <div className={styles.board_container} ref={containerElement} onScroll={handleScroll}>
                <div className={styles.board_container_shadows}>
                    <div className={styles.board}>
                        <EdgeLayer
                            className={styles.edge_layer}
                            width={totalWidth}
                            height={totalHeight}
                            padding={padding}
                            paths={edges ?? []}
                        />
                        <EdgeLayer
                            className={styles.edge_layer_focused}
                            width={totalWidth}
                            height={totalHeight}
                            padding={padding}
                            paths={edgesFocused ?? []}
                        />
                        <NodeLayer
                            width={totalWidth}
                            height={totalHeight}
                            padding={padding}
                            nodes={nodes ?? []}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
