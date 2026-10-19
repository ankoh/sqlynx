import * as React from 'react';

import { ZoomInIcon, ZoomOutIcon, ScreenFullIcon } from '../../../../../../ui/foundations/symbol_icon.js';

import { EmbeddingRendererWebGPU } from './renderer/webgpu_renderer/renderer.js';
import { EmbeddingRendererWebGL2 } from './renderer/webgl2_renderer/renderer.js';
import { isWebGPUAvailable, requestWebGPUDevice } from './renderer/webgpu_renderer/utils.js';
import type { EmbeddingRenderer } from './renderer/renderer_interface.js';
import type { Point, ViewportState } from './renderer/utils.js';
import { Viewport } from './renderer/viewport_utils.js';
import { ButtonGroup } from '../../../../../../ui/foundations/button_group.js';
import { IconButton, ButtonVariant, ButtonSize } from '../../../../../../ui/foundations/button.js';

import * as styles from './embedding_scatter.module.css';

/// The projected point cloud that drives the scatter plot. `x`/`y` are the 2D
/// coordinates (typically UMAP output), `category` is an optional per-point
/// color index in `[0, categoryCount)`.
export interface EmbeddingPoints {
    x: Float32Array;
    y: Float32Array;
    category: Uint8Array | null;
    categoryCount: number;
    categoryColors?: string[] | null;
    /// Per-point selection bitmask (bit `i` set ⇒ point `i` is selected), length
    /// `ceil(x.length / 32)`. When null, no selection is active (all points full opacity).
    selection?: Uint32Array | null;
}

interface Props {
    points: EmbeddingPoints;
    colorScheme?: 'light' | 'dark';
    pointSize?: number;
    /// Leave the background transparent so the canvas composites over whatever is behind it
    /// (used in the feed footer, where the chart should blend into the footer background).
    transparent?: boolean;
    /// Enable pan/drag with the mouse. Defaults to true.
    interactive?: boolean;
    /// Enable zooming with the scroll wheel. Disabled in the feed footer so the wheel scrolls the
    /// feed instead of being captured by the chart (dragging still works). Defaults to true.
    wheelZoom?: boolean;
    /// Called with the positional index of the nearest point to a click (within a small pick
    /// radius), or null when the click misses every point. Enabling this makes the canvas accept
    /// pointer events even when `interactive`/`wheelZoom` are off (feed footer), so clicks/hovers
    /// pick points while the wheel still scrolls the feed.
    onSelectPoint?: (index: number | null) => void;
    /// Called with the positional index of the point under the cursor on hover, or null when the
    /// cursor leaves the canvas or hovers empty space.
    onHoverPoint?: (index: number | null) => void;
    /// The point to draw a highlight ring around (effective selection = hovered ?? clicked). Null
    /// draws no ring.
    highlightedIndex?: number | null;
}

/// Movement (CSS px) below which a pointerup counts as a click rather than a pan/drag.
const CLICK_MOVE_THRESHOLD = 4;
/// Pick radius (CSS px): a click/hover only selects a point within this distance on screen.
const PICK_RADIUS = 12;

/// Median of a Float32Array without mutating the input.
function median(values: Float32Array): number {
    if (values.length === 0) return 0;
    const sorted = Float32Array.from(values).sort();
    const mid = sorted.length >> 1;
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/// Standard deviation of a Float32Array.
function stdev(values: Float32Array): number {
    if (values.length === 0) return 0;
    let mean = 0;
    for (let i = 0; i < values.length; ++i) mean += values[i];
    mean /= values.length;
    let variance = 0;
    for (let i = 0; i < values.length; ++i) {
        const d = values[i] - mean;
        variance += d * d;
    }
    variance /= values.length;
    return Math.sqrt(variance);
}

/// Compute a viewport that frames the whole point cloud, mirroring embedding-atlas's
/// EmbeddingView: center on the medians, scale so ~3 stdevs fit the [-1, 1] range.
function defaultViewport(points: EmbeddingPoints): ViewportState {
    const xCenter = median(points.x);
    const yCenter = median(points.y);
    const xStd = stdev(points.x);
    const yStd = stdev(points.y);
    const scaler = 1.0 / (Math.max(xStd, yStd, 1e-3) * 3);
    return { x: xCenter, y: yCenter, scale: scaler * 0.95 };
}

/// A WebGPU/WebGL2 scatter plot for 2D-projected embeddings. Owns the canvas,
/// acquires a rendering device (WebGPU, falling back to WebGL2), instantiates the
/// vendored embedding-atlas renderer, and wires up pan/zoom. This component is
/// intentionally decoupled from projection: it just draws the `x`/`y` it is given.
export function EmbeddingScatter(props: Props): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const rendererRef = React.useRef<EmbeddingRenderer | null>(null);
    const viewportRef = React.useRef<ViewportState>({ x: 0, y: 0, scale: 1 });
    const defaultViewportRef = React.useRef<ViewportState>({ x: 0, y: 0, scale: 1 });
    const frameRef = React.useRef<number | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const points = props.points;
    const colorScheme = props.colorScheme ?? 'light';
    const pointSize = props.pointSize ?? 2;
    const transparent = props.transparent ?? false;
    const interactive = props.interactive ?? true;
    const wheelZoom = props.wheelZoom ?? true;
    const { onSelectPoint, onHoverPoint } = props;
    const highlightedIndex = props.highlightedIndex ?? null;
    const pickable = onSelectPoint != null || onHoverPoint != null;

    // CSS-pixel position of the highlight ring, recomputed whenever the viewport or the
    // highlighted point changes. Null hides the ring.
    const [highlightPos, setHighlightPos] = React.useState<Point | null>(null);

    // The highlight ring position is recomputed from the current viewport inside syncRenderer, but
    // syncRenderer must NOT depend on the highlighted index (that would rebuild the callback and
    // retrigger the viewport-reset effect on every selection change). Bridge via a ref that always
    // points at the latest refresher.
    const refreshHighlightRef = React.useRef<() => void>(() => { });

    // Schedule a render on the next animation frame (coalesces bursts of prop /
    // interaction changes into a single draw).
    const scheduleRender = React.useCallback(() => {
        if (frameRef.current != null) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            const renderer = rendererRef.current;
            const canvas = canvasRef.current;
            if (!renderer || !canvas) return;
            canvas.width = renderer.props.width;
            canvas.height = renderer.props.height;
            renderer.render();
        });
    }, []);

    // Push the current points + viewport into the renderer and request a draw.
    const syncRenderer = React.useCallback(() => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const vp = viewportRef.current;
        const needsRender = renderer.setProps({
            x: points.x as Float32Array<ArrayBuffer>,
            y: points.y as Float32Array<ArrayBuffer>,
            category: points.category as Uint8Array<ArrayBuffer> | null,
            selection: (points.selection ?? null) as Uint32Array<ArrayBuffer> | null,
            categoryCount: Math.max(1, points.categoryCount),
            categoryColors: points.categoryColors ?? null,
            colorScheme,
            transparent,
            pointSize,
            viewportX: vp.x,
            viewportY: vp.y,
            viewportScale: vp.scale,
        });
        if (needsRender) scheduleRender();
        // Keep the highlight ring glued to its point across pan/zoom/data changes.
        refreshHighlightRef.current();
    }, [points, colorScheme, transparent, pointSize, scheduleRender]);

    // Build a Viewport for the current viewport state in CSS-pixel space (the framebuffer is
    // DPR-scaled, but all pointer interaction here is defined in CSS pixels — see the pan handler).
    const currentViewport = React.useCallback((): Viewport | null => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return new Viewport(viewportRef.current, rect.width, rect.height);
    }, []);

    // Find the nearest point to a CSS-local pixel position, or null if none is within PICK_RADIUS.
    const findNearest = React.useCallback((localX: number, localY: number): number | null => {
        const vp = currentViewport();
        if (!vp) return null;
        const { x, y } = points;
        const project = vp.pixelLocationFunction();
        let best = -1;
        let bestDist = PICK_RADIUS * PICK_RADIUS;
        for (let i = 0; i < x.length; ++i) {
            const p = project(x[i], y[i]);
            const dx = p.x - localX;
            const dy = p.y - localY;
            const d = dx * dx + dy * dy;
            if (d <= bestDist) {
                bestDist = d;
                best = i;
            }
        }
        return best >= 0 ? best : null;
    }, [points, currentViewport]);

    // Recompute the highlight ring's screen position from the current viewport.
    const refreshHighlight = React.useCallback(() => {
        if (highlightedIndex == null || highlightedIndex < 0 || highlightedIndex >= points.x.length) {
            setHighlightPos(null);
            return;
        }
        const vp = currentViewport();
        if (!vp) {
            setHighlightPos(null);
            return;
        }
        setHighlightPos(vp.pixelLocation(points.x[highlightedIndex], points.y[highlightedIndex]));
    }, [highlightedIndex, points, currentViewport]);

    // Publish the latest refresher to the ref syncRenderer reads, and refresh once now so the ring
    // tracks a selection change even without a viewport update.
    React.useEffect(() => {
        refreshHighlightRef.current = refreshHighlight;
        refreshHighlight();
    }, [refreshHighlight]);

    // Device + renderer lifecycle. Re-runs only on mount/unmount; data changes
    // are pushed through syncRenderer without rebuilding the GPU pipeline.
    React.useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        let disposed = false;

        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const rect = container.getBoundingClientRect();
        const initialWidth = Math.max(1, Math.round(rect.width * pixelRatio));
        const initialHeight = Math.max(1, Math.round(rect.height * pixelRatio));

        const setupWebGL2 = (): boolean => {
            const context = canvas.getContext('webgl2', { antialias: false });
            if (context == null) {
                setError('Could not acquire a WebGL2 context');
                return false;
            }
            context.getExtension('EXT_color_buffer_float');
            context.getExtension('EXT_float_blend');
            context.getExtension('OES_texture_float_linear');
            rendererRef.current = new EmbeddingRendererWebGL2(context, initialWidth, initialHeight);
            return true;
        };

        const setupWebGPU = async (): Promise<void> => {
            const device = await requestWebGPUDevice();
            if (disposed) {
                device?.destroy();
                return;
            }
            if (device == null) {
                setupWebGL2();
                syncRenderer();
                return;
            }
            const context = canvas.getContext('webgpu');
            if (context == null) {
                setupWebGL2();
                syncRenderer();
                return;
            }
            device.addEventListener('uncapturederror', event => {
                // eslint-disable-next-line no-console
                console.error('WebGPU uncaptured error:', (event as GPUUncapturedErrorEvent).error);
            });
            const format = navigator.gpu.getPreferredCanvasFormat();
            context.configure({ device, format, alphaMode: 'premultiplied' });
            rendererRef.current = new EmbeddingRendererWebGPU(context, device, format, initialWidth, initialHeight);
            syncRenderer();
        };

        // Try WebGPU first; fall back to WebGL2 both when WebGPU is unavailable and
        // when device/context acquisition fails inside setupWebGPU.
        if (isWebGPUAvailable()) {
            setupWebGPU().catch((e: unknown) => {
                if (disposed) return;
                if (!setupWebGL2()) {
                    setError(e instanceof Error ? e.message : String(e));
                    return;
                }
                syncRenderer();
            });
        } else {
            setupWebGL2();
            syncRenderer();
        }

        return () => {
            disposed = true;
            if (frameRef.current != null) {
                cancelAnimationFrame(frameRef.current);
                frameRef.current = null;
            }
            rendererRef.current?.destroy();
            rendererRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reset the viewport to frame the cloud whenever the coordinate buffers change,
    // then sync it into the renderer. Selection or category changes keep pan/zoom.
    const framedCoordinatesRef = React.useRef<{ x: Float32Array; y: Float32Array } | null>(null);
    React.useEffect(() => {
        const framed = framedCoordinatesRef.current;
        if (framed == null || framed.x !== points.x || framed.y !== points.y) {
            const vp = defaultViewport(points);
            defaultViewportRef.current = vp;
            viewportRef.current = vp;
            framedCoordinatesRef.current = { x: points.x, y: points.y };
        }
        syncRenderer();
    }, [points, syncRenderer]);

    // Re-sync when purely visual props change (color scheme, point size, transparency).
    React.useEffect(() => {
        syncRenderer();
    }, [colorScheme, pointSize, transparent, syncRenderer]);

    // Container resize → resize the framebuffer.
    React.useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;
        const observer = new ResizeObserver(entries => {
            const renderer = rendererRef.current;
            if (!renderer) return;
            const entry = entries[0];
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            const width = Math.max(1, Math.round(entry.contentRect.width * pixelRatio));
            const height = Math.max(1, Math.round(entry.contentRect.height * pixelRatio));
            canvas.style.width = `${entry.contentRect.width}px`;
            canvas.style.height = `${entry.contentRect.height}px`;
            renderer.setProps({ width, height });
            scheduleRender();
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [scheduleRender]);

    // Map a pointer event to canvas-local pixel coordinates.
    const localPoint = React.useCallback((clientX: number, clientY: number): Point => {
        const rect = canvasRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
        return { x: clientX - rect.left, y: clientY - rect.top };
    }, []);

    // Zoom about the cursor (wheel), mirroring EmbeddingViewImpl.onZoom.
    const onWheel = React.useCallback(
        (e: React.WheelEvent) => {
            e.preventDefault();
            const pos = localPoint(e.clientX, e.clientY);
            const { x, y, scale } = viewportRef.current;
            const scaler = Math.exp(-e.deltaY / 200);
            const baseScale = defaultViewportRef.current.scale || 1;
            const newScale = Math.min(baseScale * 1e2, Math.max(baseScale * 1e-2, scale * scaler));
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const sz = Math.max(rect.width, rect.height);
            const px = ((pos.x - rect.width / 2) / sz) * 2;
            const py = ((rect.height / 2 - pos.y) / sz) * 2;
            viewportRef.current = {
                x: x + px / scale - px / newScale,
                y: y + py / scale - py / newScale,
                scale: newScale,
            };
            syncRenderer();
        },
        [localPoint, syncRenderer],
    );

    // Drag to pan. Uses the renderer's Viewport to convert pixel deltas to data units.
    const onPointerDown = React.useCallback(
        (e: React.PointerEvent) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.setPointerCapture(e.pointerId);
            const rect = canvas.getBoundingClientRect();
            const start = viewportRef.current;
            const vp = new Viewport(start, rect.width, rect.height);
            const c0 = vp.coordinateAtPixel(0, 0);
            const c1 = vp.coordinateAtPixel(1, 1);
            const sx = c0.x - c1.x;
            const sy = c0.y - c1.y;
            const startClientX = e.clientX;
            const startClientY = e.clientY;

            const onMove = (ev: PointerEvent) => {
                viewportRef.current = {
                    x: start.x + (ev.clientX - startClientX) * sx,
                    y: start.y + (ev.clientY - startClientY) * sy,
                    scale: start.scale,
                };
                syncRenderer();
            };
            const onUp = (ev: PointerEvent) => {
                canvas.releasePointerCapture(ev.pointerId);
                canvas.removeEventListener('pointermove', onMove);
                canvas.removeEventListener('pointerup', onUp);
            };
            canvas.addEventListener('pointermove', onMove);
            canvas.addEventListener('pointerup', onUp);
        },
        [syncRenderer],
    );

    // Zoom about the viewport center by a multiplicative factor (used by the on-canvas
    // zoom buttons). Center-relative zoom keeps x/y fixed and only changes scale, clamped to
    // the same bounds as the wheel handler.
    const zoomBy = React.useCallback((factor: number) => {
        const { x, y, scale } = viewportRef.current;
        const baseScale = defaultViewportRef.current.scale || 1;
        const newScale = Math.min(baseScale * 1e2, Math.max(baseScale * 1e-2, scale * factor));
        viewportRef.current = { x, y, scale: newScale };
        syncRenderer();
    }, [syncRenderer]);

    // Restore the viewport that frames the whole cloud.
    const resetViewport = React.useCallback(() => {
        viewportRef.current = defaultViewportRef.current;
        syncRenderer();
    }, [syncRenderer]);

    // Hover picking: report the nearest point under the cursor, throttled to one lookup per frame
    // so a fast mousemove doesn't run the O(N) search many times per frame.
    const hoverFrameRef = React.useRef<number | null>(null);
    const onPointerMoveHover = React.useCallback((e: React.PointerEvent) => {
        if (onHoverPoint == null) return;
        if (hoverFrameRef.current != null) return;
        const clientX = e.clientX;
        const clientY = e.clientY;
        hoverFrameRef.current = requestAnimationFrame(() => {
            hoverFrameRef.current = null;
            const pos = localPoint(clientX, clientY);
            onHoverPoint(findNearest(pos.x, pos.y));
        });
    }, [onHoverPoint, localPoint, findNearest]);

    const onPointerLeaveHover = React.useCallback(() => {
        if (onHoverPoint == null) return;
        if (hoverFrameRef.current != null) {
            cancelAnimationFrame(hoverFrameRef.current);
            hoverFrameRef.current = null;
        }
        onHoverPoint(null);
    }, [onHoverPoint]);

    React.useEffect(() => () => {
        if (hoverFrameRef.current != null) cancelAnimationFrame(hoverFrameRef.current);
    }, []);

    // Click picking, disambiguated from a pan by a small movement threshold. Wired independently of
    // the pan handler so it also fires when `interactive` is off (feed footer). A click that lands
    // on empty space clears the selection (null).
    const onPointerDownPick = React.useCallback((e: React.PointerEvent) => {
        if (onSelectPoint == null) return;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const onUp = (ev: PointerEvent) => {
            window.removeEventListener('pointerup', onUp);
            const moved = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
            if (moved > CLICK_MOVE_THRESHOLD) return; // a drag/pan, not a click
            const pos = localPoint(ev.clientX, ev.clientY);
            onSelectPoint(findNearest(pos.x, pos.y));
        };
        window.addEventListener('pointerup', onUp);
    }, [onSelectPoint, localPoint, findNearest]);

    // Combined pointer-down: start a pan (when interactive) and/or arm click picking (when pickable).
    const onPointerDownCombined = React.useCallback((e: React.PointerEvent) => {
        if (interactive) onPointerDown(e);
        if (pickable) onPointerDownPick(e);
    }, [interactive, pickable, onPointerDown, onPointerDownPick]);

    return (
        // Keep canvas panning separate from the enclosing Electron window drag region.
        <div ref={containerRef} className={styles.root} data-electron-drag-region="false">
            {error && <div className={styles.error}>{error}</div>}
            <canvas
                ref={canvasRef}
                className={interactive ? styles.canvas : pickable ? styles.canvas_pickable : styles.canvas_static}
                onWheel={wheelZoom ? onWheel : undefined}
                onPointerDown={(interactive || pickable) ? onPointerDownCombined : undefined}
                onPointerMove={onHoverPoint != null ? onPointerMoveHover : undefined}
                onPointerLeave={onHoverPoint != null ? onPointerLeaveHover : undefined}
            />
            {/* Highlight ring for the selected/hovered point. A pure DOM overlay positioned in CSS
                pixels (the canvas fills .root via inset:0), so it stays consistent with picking and
                needs no renderer change. */}
            {highlightPos && (
                <div
                    className={styles.highlight_ring}
                    style={{ left: `${highlightPos.x}px`, top: `${highlightPos.y}px` }}
                />
            )}
            {/* The zoom/reset controls drive the viewport via onClick, so they work even when
                gesture interactivity is off (feed footer). They're a separate element from the
                pointer-events: none canvas, so they don't interfere with feed scrolling. */}
            <ButtonGroup className={styles.controls}>
                <IconButton
                    variant={ButtonVariant.Default}
                    size={ButtonSize.Small}
                    aria-label="Zoom in"
                    description="Zoom in"
                    onClick={() => zoomBy(1.4)}
                >
                    <ZoomInIcon size={12} />
                </IconButton>
                <IconButton
                    variant={ButtonVariant.Default}
                    size={ButtonSize.Small}
                    aria-label="Zoom out"
                    description="Zoom out"
                    onClick={() => zoomBy(1 / 1.4)}
                >
                    <ZoomOutIcon size={12} />
                </IconButton>
                <IconButton
                    variant={ButtonVariant.Default}
                    size={ButtonSize.Small}
                    aria-label="Reset view"
                    description="Reset view"
                    onClick={resetViewport}
                >
                    <ScreenFullIcon size={12} />
                </IconButton>
            </ButtonGroup>
        </div>
    );
}
