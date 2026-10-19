import * as React from 'react';
import { ScreenFullIcon, ZoomInIcon, ZoomOutIcon } from '../../../../../ui/foundations/symbol_icon.js';
import { color as parseColor, interpolateBrBG, interpolatePuOr, interpolateRdBu, interpolateRdPu, select, zoom, zoomIdentity, ZoomBehavior, ZoomTransform } from 'd3';

import * as dashql from '@ankoh/dashql-core';
import { JsonView } from '../../../../../ui/json/json_view.js';
import { IconButton, ButtonSize, ButtonVariant } from '../../../../../ui/foundations/button.js';
import { ButtonGroup } from '../../../../../ui/foundations/button_group.js';
import { SegmentedControl, SegmentedControlSize } from '../../../../../ui/foundations/segmented_control.js';
import { AnchoredOverlay } from '../../../../../ui/foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../../../../../ui/foundations/anchored_position.js';
import { OverlaySize } from '../../../../../ui/foundations/overlay.js';
import { SymbolIcon } from '../../../../../ui/foundations/symbol_icon.js';
import { PlanExecutionController } from './plan_execution_controller.js';
import { findPlanOperatorInDirection } from './plan_navigation.js';
import type { PlanNavigationDirection } from './plan_navigation.js';
import { getPlanOperatorSymbol, PLAN_OPERATOR_SYMBOL_SIZE, shouldRenderPlanOperatorSymbol } from './plan_operator_symbol.js';
import { estimateRelativeDifference, materializePlanScene, PLAN_OPERATOR_PORT_INPUT, PLAN_OPERATOR_PORT_OUTPUT, PlanScene, PlanSceneEdge, PlanSceneOperator } from './plan_scene.js';
import * as styles from './plan_view.module.css';

const FIT_PADDING = 24;
const EDGE_WIDTH = 2;
const EDGE_BADGE_MIN_WIDTH = 25;
const EDGE_BADGE_HEIGHT = 15;
const ESTIMATE_APPROXIMATE_ROW_THRESHOLD = 100;
const EDGE_BADGE_BORDER = 'hsl(210, 13%, 74%)';
const EDGE_HIGHLIGHT_COLOR = 'hsl(211, 100%, 45%)';
type PlanAnnotationMode = 'plain' | 'rows' | 'estimates';
const STATUS_PATHS: Record<number, string> = {
    [dashql.buffers.view.PlanExecutionStatus.UNKNOWN]: 'M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    [dashql.buffers.view.PlanExecutionStatus.PENDING]: 'M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    [dashql.buffers.view.PlanExecutionStatus.RUNNING]: 'M8 1a7 7 0 1 0 7 7h-2a5 5 0 1 1-5-5V1Z',
    [dashql.buffers.view.PlanExecutionStatus.SUCCEEDED]: 'M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5Z',
    [dashql.buffers.view.PlanExecutionStatus.FAILED]: 'M2.343 13.657A8 8 0 1 1 13.657 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.75.75 0 0 0-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 1 0 1.06 1.06L8 9.06l1.97 1.97a.75.75 0 1 0 1.06-1.06L9.06 8l1.97-1.97a.75.75 0 1 0-1.06-1.06L8 6.94 6.03 4.97Z',
    [dashql.buffers.view.PlanExecutionStatus.SKIPPED]: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm11.333-2.167a.825.825 0 0 0-1.166-1.166l-5.5 5.5a.825.825 0 0 0 1.166 1.166Z',
};

export function createPlanLayoutConfig(showProgress: boolean): dashql.buffers.view.PlanLayoutConfigT {
    const config = new dashql.buffers.view.PlanLayoutConfigT();
    config.levelHeight = 72;
    config.nodeHeight = 32;
    config.nodeMarginHorizontal = 32;
    config.nodePaddingLeft = 12;
    config.nodePaddingRight = 12;
    config.iconWidth = showProgress ? 14 : 0;
    config.iconMarginRight = showProgress ? 8 : 0;
    config.maxLabelChars = 20;
    config.widthPerLabelChar = 8.5;
    config.nodeMinWidth = 0;
    return config;
}

export interface PlanViewProps {
    plan: dashql.FlatBufferPtr<dashql.buffers.view.PlanViewModel>;
    showProgress?: boolean;
    controllerRef?: React.RefObject<PlanExecutionController | null>;
    autoFocus?: boolean;
    edgeRendering?: PlanEdgeRenderingConfig;
    dependencies?: PlanViewDependencies;
}

export interface PlanViewDependencies {
    materializePlanScene: typeof materializePlanScene;
}

const DEFAULT_DEPENDENCIES: PlanViewDependencies = {
    materializePlanScene,
};

export type PlanEdgeColorScheme = (value: number) => string;
export const PLAN_EDGE_COLOR_SCHEME_PU_OR: PlanEdgeColorScheme = interpolatePuOr;
export const PLAN_EDGE_COLOR_SCHEME_BR_BG: PlanEdgeColorScheme = interpolateBrBG;
export const PLAN_EDGE_COLOR_SCHEME_RD_BU: PlanEdgeColorScheme = value => interpolateRdBu(1 - value);
export const PLAN_EDGE_COLOR_SCHEME_RD_PU: PlanEdgeColorScheme = interpolateRdPu;

export interface PlanEdgeRenderingConfig {
    colorScheme?: PlanEdgeColorScheme;
    rowColorScheme?: PlanEdgeColorScheme;
}

interface PlanEdgeBadge {
    x: number;
    y: number;
    width: number;
    text: string;
    background: string;
    foreground: string;
    description: string;
}

interface RenderedPlanEdge {
    edge: PlanSceneEdge;
    badge: PlanEdgeBadge | null;
}

function contrastingTextColor(background: string): string {
    const rgb = parseColor(background)?.rgb();
    if (rgb == null) return '#000000';
    const linear = [rgb.r, rgb.g, rgb.b].map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    return luminance > 0.179 ? '#000000' : '#ffffff';
}

function formatRelativeDifference(difference: number): string {
    const percentage = Math.round(difference * 100);
    if (percentage > 200) return '>200%';
    if (percentage < -200) return '<-200%';
    return `${percentage > 0 ? '+' : ''}${percentage}%`;
}

export function formatEstimateSymbol(difference: number, absoluteDifference = Number.POSITIVE_INFINITY): string {
    if (difference === 0) return '=';
    if (absoluteDifference <= ESTIMATE_APPROXIMATE_ROW_THRESHOLD) return '~';
    if (difference <= -0.5) return '>>';
    if (difference <= -0.1) return '>';
    if (difference < 0) return '~';
    if (difference < 0.1) return '~';
    if (difference < 0.5) return '<';
    return '<<';
}

const ROW_COUNT_FORMAT = new Intl.NumberFormat('en-US');

function formatRowCount(value: number): string {
    return ROW_COUNT_FORMAT.format(value);
}

export function PlanView({ plan, showProgress = false, controllerRef, autoFocus = false, edgeRendering, dependencies = DEFAULT_DEPENDENCIES }: PlanViewProps) {
    const scene = React.useMemo(() => dependencies.materializePlanScene(plan), [dependencies, plan]);
    const ownController = React.useRef<PlanExecutionController | null>(null);
    ownController.current ??= new PlanExecutionController();
    const controller = controllerRef?.current ?? ownController.current;
    const viewportRef = React.useRef<HTMLDivElement | null>(null);
    const svgRef = React.useRef<SVGSVGElement | null>(null);
    const sceneRef = React.useRef<SVGGElement | null>(null);
    const zoomRef = React.useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
    const transformRef = React.useRef<ZoomTransform>(zoomIdentity);
    const [selection, setSelection] = React.useState<{ operator: PlanSceneOperator; anchor: SVGGElement } | null>(null);
    const [inspectorOpen, setInspectorOpen] = React.useState(false);
    const [annotationMode, setAnnotationMode] = React.useState<PlanAnnotationMode>('rows');
    const operatorRefs = React.useRef(new Map<number, SVGGElement>());
    const [positionRevision, setPositionRevision] = React.useState(0);
    const edgeColorScheme = edgeRendering?.colorScheme ?? PLAN_EDGE_COLOR_SCHEME_RD_BU;
    const rowColorScheme = edgeRendering?.rowColorScheme ?? PLAN_EDGE_COLOR_SCHEME_RD_PU;
    const edgeDifferenceColor = React.useCallback(
        (difference: number) => edgeColorScheme(difference < 0
            ? Math.max(0, (difference + 1) / 2)
            : Math.min(1, 0.5 + difference / 4)),
        [edgeColorScheme],
    );
    const estimateLegendGradient = React.useMemo(
        () => Array.from({ length: 11 }, (_, index) => edgeColorScheme(1 - index / 10)).join(', '),
        [edgeColorScheme],
    );
    const rowLegendGradient = React.useMemo(
        () => Array.from({ length: 11 }, (_, index) => rowColorScheme(index / 10)).join(', '),
        [rowColorScheme],
    );
    const renderedEdges: RenderedPlanEdge[] = React.useMemo(() => {
        const rowValues = scene.edges.map(edge => edge.outputCardinalityProduced ?? edge.outputCardinalityEstimated);
        const maxRowValue = rowValues.reduce((maximum, value) => Math.max(maximum, value), 0);
        return scene.edges.map((edge, edgeIndex) => {
            const child = scene.operators[edge.childOperator];
            const parent = scene.operators[edge.parentOperator];
            const actual = edge.outputCardinalityProduced;
            const difference = actual == null ? null : estimateRelativeDifference(edge.outputCardinalityEstimated, actual);
            const rowValue = rowValues[edgeIndex];
            const rowScaleValue = maxRowValue === 0 ? 0 : Math.log1p(rowValue) / Math.log1p(maxRowValue);
            const badgeText = annotationMode === 'rows' ? formatRowCount(rowValue)
                : annotationMode === 'estimates' && difference != null && actual != null
                    ? formatEstimateSymbol(difference, Math.abs(actual - edge.outputCardinalityEstimated))
                    : null;
            const background = annotationMode === 'rows' ? rowColorScheme(rowScaleValue)
                : annotationMode === 'estimates' && difference != null ? edgeDifferenceColor(difference)
                    : null;
            const description = annotationMode === 'rows'
                ? `${actual == null ? 'Estimated' : 'Actual'} rows ${rowValue}`
                : difference == null ? null
                    : `Actual rows ${actual}, estimated rows ${edge.outputCardinalityEstimated}, difference ${formatRelativeDifference(difference)}`;
            return {
                edge,
                badge: badgeText == null || background == null || description == null || child == null || parent == null ? null : {
                    x: (child.rect.x + parent.rect.x) / 2,
                    y: (child.rect.y + parent.rect.y) / 2,
                    width: Math.max(EDGE_BADGE_MIN_WIDTH, badgeText.length * 5.5 + 10),
                    text: badgeText,
                    background,
                    foreground: contrastingTextColor(background),
                    description,
                },
            };
        });
    }, [scene, annotationMode, rowColorScheme, edgeDifferenceColor]);
    const highlightedEdges = React.useMemo(() => {
        const operatorId = selection?.operator.id;
        return operatorId == null
            ? []
            : scene.edges.filter(edge => edge.childOperator === operatorId || edge.parentOperator === operatorId);
    }, [scene.edges, selection?.operator.id]);
    const highlightedEdgeSet = React.useMemo(() => new Set(highlightedEdges), [highlightedEdges]);
    const highlightedCrossEdges = React.useMemo(() => {
        const operatorId = selection?.operator.id;
        return operatorId == null
            ? []
            : scene.crossEdges.filter(edge => edge.sourceOperator === operatorId || edge.targetOperator === operatorId);
    }, [scene.crossEdges, selection?.operator.id]);
    const highlightedOutputPortOperatorIds = React.useMemo(() => new Set([
        ...highlightedEdges.map(edge => edge.childOperator),
        ...highlightedCrossEdges.map(edge => edge.sourceOperator),
    ]), [highlightedCrossEdges, highlightedEdges]);
    const highlightedInputPortOperatorIds = React.useMemo(() => new Set([
        ...highlightedEdges.map(edge => edge.parentOperator),
        ...highlightedCrossEdges.map(edge => edge.targetOperator),
    ]), [highlightedCrossEdges, highlightedEdges]);
    const describeCrossEdge = React.useCallback((operator: PlanSceneOperator) => {
        const relationships = scene.crossEdges.flatMap(edge => {
            if (edge.sourceOperator === operator.id) {
                return [`provides ${edge.kind} to ${scene.operators[edge.targetOperator]?.label ?? 'operator'}`];
            }
            if (edge.targetOperator === operator.id) {
                return [`uses ${edge.kind} from ${scene.operators[edge.sourceOperator]?.label ?? 'operator'}`];
            }
            return [];
        });
        return relationships.length > 0 ? `; ${relationships.join('; ')}` : '';
    }, [scene.crossEdges, scene.operators]);

    React.useLayoutEffect(() => {
        controller.reset(scene.operators.length, scene.pipelines.length);
        if (controllerRef != null) controllerRef.current = controller;
        return () => {
            if (controllerRef != null) controllerRef.current = null;
        };
    }, [controller, controllerRef, scene]);

    React.useLayoutEffect(() => {
        if (autoFocus) viewportRef.current?.focus();
    }, [autoFocus]);

    const fit = React.useCallback((animate = false) => {
        const viewport = viewportRef.current;
        const svg = svgRef.current;
        const behavior = zoomRef.current;
        if (viewport == null || svg == null || behavior == null || scene.width <= 0 || scene.height <= 0) return;
        const width = viewport.clientWidth;
        const height = viewport.clientHeight;
        const scale = Math.min(1, (width - FIT_PADDING * 2) / scene.width, (height - FIT_PADDING * 2) / scene.height);
        const x = (width - scene.width * scale) / 2;
        const y = (height - scene.height * scale) / 2;
        const target = zoomIdentity.translate(x, y).scale(scale);
        const targetSelection = animate ? select(svg).transition().duration(160) : select(svg);
        targetSelection.call(behavior.transform as any, target);
    }, [scene.height, scene.width]);

    // The zoom transform is applied to the DOM directly. Only the open inspector depends on the
    // operator positions, so bump its position revision at most once per frame and only while it is open.
    const inspectorVisibleRef = React.useRef(false);
    inspectorVisibleRef.current = selection != null && inspectorOpen;
    const positionRevisionFrame = React.useRef<number | null>(null);
    const schedulePositionRevision = React.useCallback(() => {
        if (positionRevisionFrame.current != null) return;
        positionRevisionFrame.current = requestAnimationFrame(() => {
            positionRevisionFrame.current = null;
            setPositionRevision(value => value + 1);
        });
    }, []);
    React.useEffect(() => () => {
        if (positionRevisionFrame.current != null) {
            cancelAnimationFrame(positionRevisionFrame.current);
            positionRevisionFrame.current = null;
        }
    }, []);

    React.useLayoutEffect(() => {
        const svg = svgRef.current;
        const viewport = viewportRef.current;
        if (svg == null || viewport == null) return;
        const behavior = zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.1, 4])
            .clickDistance(4)
            .filter(event => !event.button && !(event.target instanceof Element && event.target.closest('button')))
            .on('zoom', event => {
                transformRef.current = event.transform;
                sceneRef.current?.setAttribute('transform', event.transform.toString());
                if (inspectorVisibleRef.current) schedulePositionRevision();
            });
        zoomRef.current = behavior;
        select(svg).call(behavior).on('dblclick.zoom', null);
        const observer = new ResizeObserver(() => fit());
        observer.observe(viewport);
        fit();
        return () => {
            observer.disconnect();
            select(svg).on('.zoom', null);
            zoomRef.current = null;
        };
    }, [fit, schedulePositionRevision]);

    const zoomBy = React.useCallback((factor: number) => {
        const svg = svgRef.current;
        const behavior = zoomRef.current;
        if (svg != null && behavior != null) select(svg).transition().duration(120).call(behavior.scaleBy, factor);
    }, []);


    const onKeyDown = React.useCallback((event: React.KeyboardEvent) => {
        if (event.key === 'Escape' && inspectorOpen) {
            setInspectorOpen(false);
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        const targetIsViewport = event.target === viewportRef.current;
        const targetIsOperator = event.target instanceof Element && event.target.matches('[data-plan-operator-id]');
        if (!targetIsViewport && !targetIsOperator) return;

        const direction: PlanNavigationDirection | null = event.key === 'ArrowLeft' ? 'left'
            : event.key === 'ArrowRight' ? 'right'
                : event.key === 'ArrowUp' ? 'up'
                    : event.key === 'ArrowDown' ? 'down'
                        : null;
        if (direction != null) {
            const targetOperatorId = targetIsOperator
                ? Number((event.target as Element).getAttribute('data-plan-operator-id'))
                : null;
            const current = targetOperatorId == null
                ? selection?.operator ?? null
                : scene.operators.find(operator => operator.id === targetOperatorId) ?? null;
            const next = findPlanOperatorInDirection(scene.operators, scene.edges, current, direction);
            const anchor = next == null ? null : operatorRefs.current.get(next.id) ?? null;
            if (next != null && anchor != null) {
                setSelection({ operator: next, anchor });
                setPositionRevision(value => value + 1);
                anchor.focus();
            }
        } else if (event.key === '+' || event.key === '=') zoomBy(1.25);
        else if (event.key === '-') zoomBy(0.8);
        else if (event.key === 'f') fit(true);
        else return;
        event.preventDefault();
        event.stopPropagation();
    }, [fit, inspectorOpen, scene.operators, selection?.operator, zoomBy]);

    // Stable operator callbacks so that the memoized operator nodes only re-render when their own props change
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    const setOperatorAnchor = React.useCallback((operatorId: number, anchor: SVGGElement | null) => {
        if (anchor == null) operatorRefs.current.delete(operatorId);
        else operatorRefs.current.set(operatorId, anchor);
    }, []);
    const onFocusOperator = React.useCallback((selected: PlanSceneOperator, anchor: SVGGElement) => {
        setSelection({ operator: selected, anchor });
    }, []);
    const onSelectOperator = React.useCallback((selected: PlanSceneOperator, anchor: SVGGElement, toggle: boolean) => {
        const previous = selectionRef.current;
        setSelection({ operator: selected, anchor });
        setPositionRevision(value => value + 1);
        setInspectorOpen(open => toggle && previous?.operator.id === selected.id ? !open : true);
    }, []);

    const anchorRef = React.useMemo(() => ({ current: selection?.anchor ?? null }), [selection?.anchor]);
    return (
        <div
            ref={viewportRef}
            className={styles.viewport}
            role="region"
            aria-label={`Query execution plan with ${scene.operators.length} operators`}
            tabIndex={0}
            onKeyDown={onKeyDown}
            data-electron-drag-region="false"
        >
            <svg ref={svgRef} className={styles.svg} onClick={event => {
                if (event.target === svgRef.current) {
                    setSelection(null);
                    setInspectorOpen(false);
                }
            }}>
                <g ref={sceneRef}>
                    <g>
                        {scene.fragments.map((fragment, fragmentIndex) => (
                            <g
                                key={fragment.id}
                                role="img"
                                aria-label={`Fragment ${fragment.id + 1}, containing operators: ${fragment.operatorIds
                                    .map(operatorId => scene.operators[operatorId]?.label)
                                    .filter((label): label is string => label != null)
                                    .join(', ')}`}
                            >
                                <path
                                    className={styles.fragment}
                                    d={fragment.path}
                                    data-color={fragmentIndex % 6}
                                />
                            </g>
                        ))}
                    </g>
                    <g>
                        {scene.pipelines.map(pipeline => (
                            <path
                                key={pipeline.id}
                                ref={path => controller.registerPipeline(pipeline.id, path)}
                                className={styles.pipeline}
                                d={pipeline.path}
                                aria-hidden="true"
                            />
                        ))}
                    </g>
                    <g aria-hidden="true">
                        {renderedEdges.map(rendered => (
                            <path
                                key={rendered.edge.id.toString()}
                                className={styles.edge}
                                d={rendered.edge.path}
                                style={{ strokeWidth: EDGE_WIDTH }}
                                data-plan-edge-id={rendered.edge.id.toString()}
                            />
                        ))}
                    </g>
                    <g aria-hidden="true">
                        {scene.crossEdges.map(edge => (
                            <path
                                key={edge.id.toString()}
                                className={styles.crossEdge}
                                data-kind={edge.kind}
                                d={edge.path}
                            />
                        ))}
                    </g>
                    <g className={styles.edgeHighlightLayer} aria-hidden="true">
                        {highlightedEdges.map(edge => (
                            <path
                                key={`edge-${edge.id}`}
                                className={styles.edgeHighlight}
                                d={edge.path}
                                style={{ strokeWidth: EDGE_WIDTH }}
                                data-plan-edge-highlight-id={edge.id.toString()}
                            />
                        ))}
                        {highlightedCrossEdges.map(edge => (
                            <path
                                key={`cross-edge-${edge.id}`}
                                className={styles.crossEdgeHighlight}
                                d={edge.path}
                                data-plan-cross-edge-highlight-id={edge.id.toString()}
                            />
                        ))}
                    </g>
                    <g className={styles.edgeBadgeLayer}>
                        {annotationMode !== 'plain' && renderedEdges.flatMap(rendered => rendered.badge == null ? [] : [(
                            <g
                                key={rendered.edge.id.toString()}
                                className={styles.edgeBadge}
                                transform={`translate(${rendered.badge.x}, ${rendered.badge.y})`}
                                role="img"
                                aria-label={rendered.badge.description}
                                data-plan-edge-badge-id={rendered.edge.id.toString()}
                                data-highlighted={highlightedEdgeSet.has(rendered.edge) || undefined}
                            >
                                <rect
                                    x={-rendered.badge.width / 2}
                                    y={-EDGE_BADGE_HEIGHT / 2}
                                    width={rendered.badge.width}
                                    height={EDGE_BADGE_HEIGHT}
                                    rx={EDGE_BADGE_HEIGHT / 2}
                                    fill={highlightedEdgeSet.has(rendered.edge) ? EDGE_HIGHLIGHT_COLOR : rendered.badge.background}
                                    stroke={highlightedEdgeSet.has(rendered.edge) ? EDGE_HIGHLIGHT_COLOR : EDGE_BADGE_BORDER}
                                />
                                <text fill={highlightedEdgeSet.has(rendered.edge) ? '#ffffff' : rendered.badge.foreground}>{rendered.badge.text}</text>
                            </g>
                        )])}
                    </g>
                    <g>
                        {scene.operators.map(operator => (
                            <PlanOperatorNode
                                key={operator.id}
                                operator={operator}
                                scene={scene}
                                showProgress={showProgress}
                                selected={selection?.operator.id === operator.id}
                                highlightedOutputPort={highlightedOutputPortOperatorIds.has(operator.id)}
                                highlightedInputPort={highlightedInputPortOperatorIds.has(operator.id)}
                                expanded={inspectorOpen && selection?.operator.id === operator.id}
                                controller={controller}
                                relationshipDescription={describeCrossEdge(operator)}
                                setAnchor={setOperatorAnchor}
                                onFocus={onFocusOperator}
                                onSelect={onSelectOperator}
                            />
                        ))}
                    </g>
                </g>
            </svg>
            <div className={styles.metric_controls}>
                <SegmentedControl
                    aria-label="Plan annotations"
                    size={SegmentedControlSize.Tiny}
                    onChange={index => setAnnotationMode(index === 0 ? 'plain' : index === 1 ? 'rows' : 'estimates')}
                >
                    <SegmentedControl.Button selected={annotationMode === 'plain'}>Plain</SegmentedControl.Button>
                    <SegmentedControl.Button selected={annotationMode === 'rows'}>Rows</SegmentedControl.Button>
                    <SegmentedControl.Button selected={annotationMode === 'estimates'}>Estimates</SegmentedControl.Button>
                </SegmentedControl>
            </div>
            {annotationMode === 'rows' && (
                <div
                    className={styles.edge_legend}
                    role="img"
                    aria-label="Badge color encodes row count from fewer rows on the left to more rows on the right"
                >
                    <div className={styles.edge_legend_scale}>
                        <span>Fewer rows</span>
                        <span>More rows</span>
                        <i
                            aria-hidden="true"
                            style={{ backgroundImage: `linear-gradient(to right, ${rowLegendGradient})` }}
                        />
                    </div>
                </div>
            )}
            {annotationMode === 'estimates' && (
                <div
                    className={styles.edge_legend}
                    role="img"
                    aria-label="Badge color compares actual rows with estimates: red on the left means underestimated, the center means matched, and blue on the right means overestimated; differences are capped at 200 percent"
                >
                    <div className={styles.edge_legend_scale}>
                        <span>Underestimated</span>
                        <span>Overestimated</span>
                        <i
                            aria-hidden="true"
                            style={{ backgroundImage: `linear-gradient(to right, ${estimateLegendGradient})` }}
                        />
                        <span className={styles.edge_legend_matched}>Matched</span>
                    </div>
                </div>
            )}
            <ButtonGroup className={styles.controls} aria-label="Plan zoom controls">
                <IconButton variant={ButtonVariant.Default} size={ButtonSize.Small} aria-label="Zoom in" onClick={() => zoomBy(1.25)}><ZoomInIcon size={12} /></IconButton>
                <IconButton variant={ButtonVariant.Default} size={ButtonSize.Small} aria-label="Zoom out" onClick={() => zoomBy(0.8)}><ZoomOutIcon size={12} /></IconButton>
                <IconButton variant={ButtonVariant.Default} size={ButtonSize.Small} aria-label="Fit plan" onClick={() => fit(true)}><ScreenFullIcon size={12} /></IconButton>
            </ButtonGroup>
            <AnchoredOverlay
                renderAnchor={null}
                anchorRef={anchorRef}
                open={selection != null && inspectorOpen}
                onClose={() => setInspectorOpen(false)}
                side={AnchorSide.OutsideRight}
                align={AnchorAlignment.Center}
                anchorOffset={8}
                width={OverlaySize.L}
                maxHeight={OverlaySize.L}
                positionRevision={positionRevision}
            >
                <section className={styles.inspector} aria-label={`${selection?.operator.label ?? 'Operator'} properties`}>
                    <header
                        className={styles.inspector_header}
                        data-single-line={selection?.operator.typeName == null || selection.operator.typeName === selection.operator.label}
                    >
                        <strong>{selection?.operator.label}</strong>
                        {selection?.operator.typeName != null && selection.operator.typeName !== selection.operator.label && (
                            <span>{selection.operator.typeName}</span>
                        )}
                    </header>
                    {selection != null && (
                        <JsonView
                            className={styles.inspector_json}
                            value={selection.operator.properties}
                            collapsed={2}
                            shortenTextAfterLength={100}
                        />
                    )}
                </section>
            </AnchoredOverlay>
        </div>
    );
}

const PlanOperatorNode = React.memo(function PlanOperatorNode(props: {
    operator: PlanSceneOperator;
    scene: PlanScene;
    showProgress: boolean;
    selected: boolean;
    highlightedOutputPort: boolean;
    highlightedInputPort: boolean;
    expanded: boolean;
    controller: PlanExecutionController;
    relationshipDescription: string;
    setAnchor: (operatorId: number, anchor: SVGGElement | null) => void;
    onFocus: (operator: PlanSceneOperator, anchor: SVGGElement) => void;
    onSelect: (operator: PlanSceneOperator, anchor: SVGGElement, toggle: boolean) => void;
}) {
    const { operator, scene } = props;
    const labelClipId = React.useId();
    const setAnchor = React.useCallback((anchor: SVGGElement | null) => props.setAnchor(operator.id, anchor), [props.setAnchor, operator.id]);
    const x = operator.rect.x - operator.rect.width / 2;
    const y = operator.rect.y - operator.rect.height / 2;
    const input = scene.layoutConfig.input!;
    const regionStart = input.nodePaddingLeft + input.iconWidth + input.iconMarginRight;
    const regionEnd = operator.rect.width - input.nodePaddingRight;
    const renderSymbol = shouldRenderPlanOperatorSymbol(operator.typeName, operator.label);
    const symbolName = renderSymbol ? getPlanOperatorSymbol(operator.typeName) : null;
    const OperatorSymbol = symbolName != null ? SymbolIcon(symbolName) : null;
    const activate = (event: React.MouseEvent<SVGGElement> | React.KeyboardEvent<SVGGElement>) => {
        if ('key' in event && event.key !== 'Enter' && event.key !== ' ') return;
        if ('key' in event) event.preventDefault();
        event.stopPropagation();
        props.onSelect(operator, event.currentTarget, 'key' in event);
    };
    return (
        <g
            ref={setAnchor}
            className={styles.operator}
            data-selected={props.selected}
            data-highlighted-output-port={props.highlightedOutputPort}
            data-highlighted-input-port={props.highlightedInputPort}
            data-plan-operator-id={operator.id}
            transform={`translate(${x}, ${y})`}
            role="button"
            tabIndex={0}
            aria-label={`${operator.label}${props.relationshipDescription}, show properties`}
            aria-expanded={props.expanded}
            onClick={activate}
            onFocus={event => props.onFocus(operator, event.currentTarget)}
            onKeyDown={activate}
        >
            <rect
                className={styles.operator_frame}
                width={operator.rect.width}
                height={operator.rect.height}
                rx={6}
                ry={6}
                data-plan-operator-frame
            />
            <clipPath id={labelClipId}>
                <path d={`M ${regionStart} 0 H ${regionEnd} V ${input.nodeHeight} H ${regionStart} Z`} />
            </clipPath>
            {props.showProgress && (
                <g
                    ref={slot => props.controller.registerOperator(operator.id, slot)}
                    className={styles.status}
                    transform={`translate(${input.nodePaddingLeft}, ${(input.nodeHeight - input.iconWidth) / 2})`}
                    aria-hidden="true"
                >
                    {Object.entries(STATUS_PATHS).map(([status, path]) => <path key={status} data-status-icon={status} d={path} transform={`scale(${input.iconWidth / 16})`} />)}
                </g>
            )}
            {OperatorSymbol != null
                ? <g className={styles.operator_symbol} transform={`translate(${(regionStart + regionEnd - PLAN_OPERATOR_SYMBOL_SIZE) / 2}, ${(input.nodeHeight - PLAN_OPERATOR_SYMBOL_SIZE) / 2})`} aria-hidden="true"><OperatorSymbol size={PLAN_OPERATOR_SYMBOL_SIZE} /></g>
                : <text clipPath={`url(#${labelClipId})`} x={(regionStart + regionEnd) / 2} y={input.nodeHeight / 2 + 5}>{operator.displayLabel}</text>}
            {(operator.ports & PLAN_OPERATOR_PORT_OUTPUT) !== 0 && (
                <g
                    className={styles.operator_port}
                    transform={`translate(${operator.rect.width / 2}, 0)`}
                    data-plan-port="output"
                    aria-hidden="true"
                >
                    <path className={styles.operator_port_border} d="M -5 0 A 5 5 0 0 1 5 0" />
                    <circle className={styles.operator_port_mask} r={4} />
                    <circle className={styles.operator_port_dot} r={2.5} />
                </g>
            )}
            {(operator.ports & PLAN_OPERATOR_PORT_INPUT) !== 0 && (
                <g
                    className={styles.operator_port}
                    transform={`translate(${operator.rect.width / 2}, ${operator.rect.height})`}
                    data-plan-port="input"
                    aria-hidden="true"
                >
                    <path className={styles.operator_port_border} d="M -5 0 A 5 5 0 0 0 5 0" />
                    <circle className={styles.operator_port_mask} r={4} />
                    <circle className={styles.operator_port_dot} r={2.5} />
                </g>
            )}
        </g>
    );
});
