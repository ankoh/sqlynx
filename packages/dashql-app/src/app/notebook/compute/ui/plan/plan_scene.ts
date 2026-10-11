import * as dashql from '@ankoh/dashql-core';
import { U32_MAX } from '../../../../../utils/numeric_limits.js';
import { buildEdgePathBetweenRectangles, PathBuilder, selectVerticalEdgeType } from '../../../../../utils/graph_edges.js';
import { getPlanOperatorDisplayWidth } from './plan_operator_symbol.js';

export interface PlanSceneRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PlanSceneOperator {
    id: number;
    typeName: string | null;
    label: string;
    displayLabel: string;
    rect: PlanSceneRect;
    ports: number;
    statistics: PlanSceneOperatorStatistics;
    properties: Record<string, unknown>;
}

export interface PlanSceneOperatorStatistics {
    inputCardinalityEstimated: number;
    inputCardinalityConsumed: bigint;
    outputCardinalityEstimated: number;
    outputCardinalityProduced: bigint;
    hasOutputCardinalityProduced: boolean;
    memoryBytes: bigint;
}

export const PLAN_OPERATOR_PORT_OUTPUT = 0b01;
export const PLAN_OPERATOR_PORT_INPUT = 0b10;

export interface PlanSceneEdge {
    id: bigint;
    childOperator: number;
    parentOperator: number;
    outputCardinalityEstimated: number;
    outputCardinalityProduced: number | null;
    path: string;
}

export interface PlanSceneCrossEdge {
    id: bigint;
    sourceOperator: number;
    targetOperator: number;
    kind: string;
    properties: Record<string, unknown>;
    path: string;
}

export interface PlanScenePipeline {
    id: number;
    operatorIds: readonly number[];
    path: string;
}

export interface PlanSceneFragment {
    id: number;
    operatorIds: readonly number[];
    path: string;
}

export interface PlanScene {
    width: number;
    height: number;
    layoutConfig: dashql.buffers.view.DerivedPlanLayoutConfigT;
    operators: readonly PlanSceneOperator[];
    edges: readonly PlanSceneEdge[];
    crossEdges: readonly PlanSceneCrossEdge[];
    fragments: readonly PlanSceneFragment[];
    pipelines: readonly PlanScenePipeline[];
}

function readString(vm: dashql.buffers.view.PlanViewModel, id: number): string | null {
    return id !== U32_MAX ? vm.stringDictionary(id) : null;
}

function readProperties(vm: dashql.buffers.view.PlanViewModel, op: dashql.buffers.view.PlanOperator): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const attribute = new dashql.buffers.view.PlanAttribute();
    for (let i = 0; i < op.attributeCount(); ++i) {
        const value = vm.attributes(op.attributesBegin() + i, attribute);
        if (value == null) continue;
        const name = readString(vm, value.name());
        const json = readString(vm, value.valueJson());
        if (name == null || json == null) continue;
        try {
            properties[name] = JSON.parse(json);
        } catch {
            properties[name] = json;
        }
    }
    return properties;
}

function readAttributeRange(
    vm: dashql.buffers.view.PlanViewModel,
    begin: number,
    count: number,
): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const attribute = new dashql.buffers.view.PlanAttribute();
    for (let i = 0; i < count; ++i) {
        const value = vm.attributes(begin + i, attribute);
        if (value == null) continue;
        const name = readString(vm, value.name());
        const json = readString(vm, value.valueJson());
        if (name == null || json == null) continue;
        try {
            properties[name] = JSON.parse(json);
        } catch {
            properties[name] = json;
        }
    }
    return properties;
}

function readNumberProperty(value: unknown, names: readonly string[]): number | null {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
    const properties = value as Record<string, unknown>;
    for (const name of names) {
        const metric = properties[name];
        if (typeof metric === 'number' && Number.isFinite(metric)) return metric;
    }
    return null;
}

export function hasOutputCardinalityProduced(properties: Record<string, unknown>): boolean {
    const statistics = properties.statistics;
    return readNumberProperty(statistics, ['output-rows', 'outputRows']) != null
        || readNumberProperty(properties, ['output-rows', 'outputRows']) != null;
}

export function estimateRelativeDifference(estimated: number, actual: number): number {
    if (estimated === 0) return actual === 0 ? 0 : Number.POSITIVE_INFINITY;
    return (actual - estimated) / Math.abs(estimated);
}

export function buildCrossEdgePath(
    source: PlanSceneRect,
    target: PlanSceneRect,
    minHandleLength = 24,
    minInputHandleLength = 48,
): string {
    const sourceX = source.x;
    const sourceY = source.y - source.height / 2;
    const targetX = target.x;
    const targetY = target.y + target.height / 2;
    const sourceHandleLength = Math.max(minHandleLength, Math.abs(sourceY - targetY) / 2);
    const targetHandleLength = Math.max(minInputHandleLength, sourceHandleLength);
    return `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY - sourceHandleLength}, ${targetX} ${targetY + targetHandleLength}, ${targetX} ${targetY}`;
}

export function truncatePlanLabel(label: string, maxChars: number): string {
    const chars = Array.from(label);
    if (chars.length <= maxChars) return label;
    if (maxChars === 0) return '';
    return `${chars.slice(0, maxChars - 1).join('')}…`;
}

function buildPipelinePath(operatorIds: readonly number[], operators: readonly PlanSceneOperator[]): string {
    if (operatorIds.length === 0) return '';
    const padding = 4;
    const radius = 8;
    const parts: string[] = [];
    for (const operatorId of operatorIds) {
        const op = operators[operatorId];
        if (op == null) continue;
        const x = op.rect.x - op.rect.width / 2 - padding;
        const y = op.rect.y - op.rect.height / 2 - padding;
        const width = op.rect.width + padding * 2;
        const height = op.rect.height + padding * 2;
        parts.push(`M ${x + radius} ${y} H ${x + width - radius} Q ${x + width} ${y} ${x + width} ${y + radius} V ${y + height - radius} Q ${x + width} ${y + height} ${x + width - radius} ${y + height} H ${x + radius} Q ${x} ${y + height} ${x} ${y + height - radius} V ${y + radius} Q ${x} ${y} ${x + radius} ${y} Z`);
    }
    return parts.join(' ');
}

interface FragmentPoint {
    x: number;
    y: number;
}

interface FragmentSegment {
    from: FragmentPoint;
    to: FragmentPoint;
}

function pointKey(point: FragmentPoint): string {
    return `${point.x},${point.y}`;
}

function segmentDirection(segment: FragmentSegment): number {
    if (segment.to.x > segment.from.x) return 0;
    if (segment.to.y > segment.from.y) return 1;
    if (segment.to.x < segment.from.x) return 2;
    return 3;
}

function selectNextFragmentSegment(
    candidates: readonly FragmentSegment[] | undefined,
    previous: FragmentSegment,
    unused: ReadonlySet<FragmentSegment>,
): FragmentSegment | undefined {
    const previousDirection = segmentDirection(previous);
    const turnPriority = [1, 0, 3, 2];
    for (const turn of turnPriority) {
        const direction = (previousDirection + turn) % 4;
        const candidate = candidates?.find(segment => unused.has(segment) && segmentDirection(segment) === direction);
        if (candidate != null) return candidate;
    }
    return undefined;
}

function renderRoundedFragmentContour(points: readonly FragmentPoint[], radius: number): string {
    const contour = points.length > 1 && pointKey(points[0]) === pointKey(points[points.length - 1])
        ? points.slice(0, -1)
        : points;
    if (contour.length < 3) return '';

    const corners = contour.map((point, index) => {
        const previous = contour[(index + contour.length - 1) % contour.length];
        const next = contour[(index + 1) % contour.length];
        const previousDistance = Math.abs(previous.x - point.x) + Math.abs(previous.y - point.y);
        const nextDistance = Math.abs(next.x - point.x) + Math.abs(next.y - point.y);
        const offset = Math.min(radius, previousDistance / 2, nextDistance / 2);
        const entry = {
            x: point.x + Math.sign(previous.x - point.x) * offset,
            y: point.y + Math.sign(previous.y - point.y) * offset,
        };
        const exit = {
            x: point.x + Math.sign(next.x - point.x) * offset,
            y: point.y + Math.sign(next.y - point.y) * offset,
        };
        return { point, entry, exit };
    });

    const first = corners[0];
    const parts = [`M ${first.entry.x} ${first.entry.y}`, `Q ${first.point.x} ${first.point.y} ${first.exit.x} ${first.exit.y}`];
    for (let i = 1; i < corners.length; ++i) {
        const corner = corners[i];
        parts.push(`L ${corner.entry.x} ${corner.entry.y}`);
        parts.push(`Q ${corner.point.x} ${corner.point.y} ${corner.exit.x} ${corner.exit.y}`);
    }
    parts.push('Z');
    return parts.join(' ');
}

function appendFragmentRect(rectangles: PlanSceneRect[], rect: PlanSceneRect, padding: number): void {
    rectangles.push({
        x: rect.x - rect.width / 2 - padding,
        y: rect.y - rect.height / 2 - padding,
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
    });
}

function appendFragmentCorridor(
    rectangles: PlanSceneRect[],
    from: PlanSceneRect,
    to: PlanSceneRect,
    width: number,
): void {
    const halfWidth = width / 2;
    const direction = Math.sign(to.y - from.y) || 1;
    const fromY = from.y + direction * from.height / 2;
    const toY = to.y - direction * to.height / 2;
    const midY = (fromY + toY) / 2;
    rectangles.push({
        x: from.x - halfWidth,
        y: Math.min(fromY, midY) - halfWidth,
        width,
        height: Math.abs(midY - fromY) + width,
    });
    rectangles.push({
        x: Math.min(from.x, to.x) - halfWidth,
        y: midY - halfWidth,
        width: Math.abs(to.x - from.x) + width,
        height: width,
    });
    rectangles.push({
        x: to.x - halfWidth,
        y: Math.min(midY, toY) - halfWidth,
        width,
        height: Math.abs(toY - midY) + width,
    });
}

function traceFragmentRectangles(rectangles: readonly PlanSceneRect[]): string {
    if (rectangles.length === 0) return '';
    const xs = Array.from(new Set(rectangles.flatMap(rect => [rect.x, rect.x + rect.width]))).sort((a, b) => a - b);
    const ys = Array.from(new Set(rectangles.flatMap(rect => [rect.y, rect.y + rect.height]))).sort((a, b) => a - b);
    const filled = Array.from({ length: ys.length - 1 }, () => new Uint8Array(xs.length - 1));
    for (const rect of rectangles) {
        const left = xs.indexOf(rect.x);
        const right = xs.indexOf(rect.x + rect.width);
        const top = ys.indexOf(rect.y);
        const bottom = ys.indexOf(rect.y + rect.height);
        for (let y = top; y < bottom; ++y) {
            for (let x = left; x < right; ++x) filled[y][x] = 1;
        }
    }

    const segments: FragmentSegment[] = [];
    const isFilled = (x: number, y: number) => y >= 0 && y < filled.length && x >= 0 && x < filled[y].length && filled[y][x] !== 0;
    for (let y = 0; y < filled.length; ++y) {
        for (let x = 0; x < filled[y].length; ++x) {
            if (!isFilled(x, y)) continue;
            if (!isFilled(x, y - 1)) segments.push({ from: { x: xs[x], y: ys[y] }, to: { x: xs[x + 1], y: ys[y] } });
            if (!isFilled(x + 1, y)) segments.push({ from: { x: xs[x + 1], y: ys[y] }, to: { x: xs[x + 1], y: ys[y + 1] } });
            if (!isFilled(x, y + 1)) segments.push({ from: { x: xs[x + 1], y: ys[y + 1] }, to: { x: xs[x], y: ys[y + 1] } });
            if (!isFilled(x - 1, y)) segments.push({ from: { x: xs[x], y: ys[y + 1] }, to: { x: xs[x], y: ys[y] } });
        }
    }

    const segmentsByStart = new Map<string, FragmentSegment[]>();
    for (const segment of segments) {
        const key = pointKey(segment.from);
        const candidates = segmentsByStart.get(key);
        if (candidates == null) segmentsByStart.set(key, [segment]);
        else candidates.push(segment);
    }

    const parts: string[] = [];
    const unused = new Set(segments);
    while (unused.size > 0) {
        const first = unused.values().next().value!;
        unused.delete(first);
        const start = first.from;
        let previousSegment = first;
        let current = first.to;
        const points = [start, current];
        while (pointKey(current) !== pointKey(start)) {
            const candidates = segmentsByStart.get(pointKey(current));
            const next = selectNextFragmentSegment(candidates, previousSegment, unused);
            if (next == null) break;
            unused.delete(next);
            previousSegment = next;
            current = next.to;
            const previous = points[points.length - 1];
            const beforePrevious = points[points.length - 2];
            if (beforePrevious != null
                && (beforePrevious.x === previous.x && previous.x === current.x
                    || beforePrevious.y === previous.y && previous.y === current.y)) {
                points[points.length - 1] = current;
            } else {
                points.push(current);
            }
        }
        if (pointKey(current) === pointKey(start)) {
            const path = renderRoundedFragmentContour(points, 8);
            if (path.length > 0) parts.push(path);
        }
    }
    return parts.join(' ');
}

export function buildFragmentPath(
    operatorIds: readonly number[],
    operators: readonly Pick<PlanSceneOperator, 'rect'>[],
    edges: readonly Pick<PlanSceneEdge, 'childOperator' | 'parentOperator'>[] = [],
    padding = 12,
    corridorWidth = padding * 2,
): string {
    const rectangles: PlanSceneRect[] = [];
    const memberIds = new Set(operatorIds);
    for (const operatorId of operatorIds) {
        const op = operators[operatorId];
        if (op == null) continue;
        appendFragmentRect(rectangles, op.rect, padding);
    }
    for (const edge of edges) {
        if (!memberIds.has(edge.childOperator) || !memberIds.has(edge.parentOperator)) continue;
        const child = operators[edge.childOperator];
        const parent = operators[edge.parentOperator];
        if (child == null || parent == null) continue;
        appendFragmentCorridor(rectangles, child.rect, parent.rect, corridorWidth);
    }
    return traceFragmentRectangles(rectangles);
}

export function materializePlanScene(viewModel: dashql.FlatBufferPtr<dashql.buffers.view.PlanViewModel>): PlanScene {
    const vm = viewModel.read();
    const layoutConfig = vm.layoutConfig()!.unpack();
    const operators: PlanSceneOperator[] = new Array(vm.operatorsLength());
    const tmpOperator = new dashql.buffers.view.PlanOperator();
    const tmpStatistics = new dashql.buffers.view.PlanExecutionStatistics();
    for (let i = 0; i < vm.operatorsLength(); ++i) {
        const op = vm.operators(i, tmpOperator)!;
        const layout = op.layoutRect()!;
        const statistics = op.executionStatistics(tmpStatistics)!;
        const typeName = readString(vm, op.operatorTypeName());
        const label = readString(vm, op.operatorLabel()) ?? typeName ?? 'operator';
        const properties = readProperties(vm, op);
        const hasProducedRows = hasOutputCardinalityProduced(properties);
        const input = layoutConfig.input!;
        const width = getPlanOperatorDisplayWidth(
            typeName,
            label,
            layout.width(),
            input.nodePaddingLeft,
            input.iconWidth,
            input.iconMarginRight,
            input.nodePaddingRight,
        );
        operators[op.operatorId()] = {
            id: op.operatorId(),
            typeName,
            label,
            displayLabel: truncatePlanLabel(label, layoutConfig.input!.maxLabelChars),
            rect: { x: layout.x(), y: layout.y(), width, height: layout.height() },
            ports: 0,
            statistics: {
                inputCardinalityEstimated: statistics.inputCardinalityEstimated(),
                inputCardinalityConsumed: statistics.inputCardinalityConsumed(),
                outputCardinalityEstimated: statistics.outputCardinalityEstimated(),
                outputCardinalityProduced: statistics.outputCardinalityProduced(),
                hasOutputCardinalityProduced: hasProducedRows,
                memoryBytes: statistics.memoryBytes(),
            },
            properties,
        };
    }

    const edges: PlanSceneEdge[] = [];
    const tmpEdge = new dashql.buffers.view.PlanOperatorEdge();
    for (let i = 0; i < vm.operatorEdgesLength(); ++i) {
        const edge = vm.operatorEdges(i, tmpEdge)!;
        const child = operators[edge.childOperator()];
        const parent = operators[edge.parentOperator()];
        child.ports |= PLAN_OPERATOR_PORT_OUTPUT;
        parent.ports |= PLAN_OPERATOR_PORT_INPUT;
        const edgeType = selectVerticalEdgeType(child.rect.x, child.rect.y, parent.rect.x, parent.rect.y);
        const path = buildEdgePathBetweenRectangles(
            new PathBuilder(), edgeType,
            child.rect.x, child.rect.y, parent.rect.x, parent.rect.y,
            child.rect.width, child.rect.height, parent.rect.width, parent.rect.height, 4,
        ).render();
        edges.push({
            id: edge.edgeId(),
            childOperator: child.id,
            parentOperator: parent.id,
            outputCardinalityEstimated: child.statistics.outputCardinalityEstimated,
            outputCardinalityProduced: child.statistics.hasOutputCardinalityProduced
                ? Number(child.statistics.outputCardinalityProduced)
                : null,
            path,
        });
    }

    const crossEdges: PlanSceneCrossEdge[] = [];
    const tmpCrossEdge = new dashql.buffers.view.PlanOperatorCrossEdge();
    for (let i = 0; i < vm.operatorCrossEdgesLength(); ++i) {
        const edge = vm.operatorCrossEdges(i, tmpCrossEdge)!;
        const source = operators[edge.sourceNode()];
        const target = operators[edge.targetNode()];
        if (source == null || target == null) continue;
        source.ports |= PLAN_OPERATOR_PORT_OUTPUT;
        target.ports |= PLAN_OPERATOR_PORT_INPUT;
        const properties = readAttributeRange(vm, edge.attributesBegin(), edge.attributeCount());
        crossEdges.push({
            id: edge.edgeId(),
            sourceOperator: source.id,
            targetOperator: target.id,
            kind: typeof properties.kind === 'string' ? properties.kind : 'reference',
            properties,
            path: buildCrossEdgePath(source.rect, target.rect),
        });
    }

    const fragments: PlanSceneFragment[] = [];
    const tmpFragment = new dashql.buffers.view.PlanFragment();
    for (let i = 0; i < vm.fragmentsLength(); ++i) {
        const fragment = vm.fragments(i, tmpFragment)!;
        const anchorOperator = fragment.anchorOperator();
        if (operators[anchorOperator]?.typeName === 'executiontarget') continue;
        const operatorIds: number[] = [];
        for (let j = 0; j < fragment.operatorCount(); ++j) {
            const operatorId = vm.fragmentOperators(fragment.operatorsBegin() + j);
            if (operatorId != null) operatorIds.push(operatorId);
        }
        fragments.push({
            id: fragment.fragmentId(),
            operatorIds,
            path: buildFragmentPath(operatorIds, operators, edges),
        });
    }

    const pipelines: PlanScenePipeline[] = [];
    const tmpPipeline = new dashql.buffers.view.PlanPipeline();
    for (let i = 0; i < vm.pipelinesLength(); ++i) {
        const pipeline = vm.pipelines(i, tmpPipeline)!;
        const operatorIds: number[] = [];
        for (let j = 0; j < pipeline.operatorCount(); ++j) {
            const operatorId = vm.pipelineOperators(pipeline.operatorsBegin() + j);
            if (operatorId != null) operatorIds.push(operatorId);
        }
        pipelines[pipeline.pipelineId()] = {
            id: pipeline.pipelineId(),
            operatorIds,
            path: buildPipelinePath(operatorIds, operators),
        };
    }

    const bounds = vm.layoutRect();
    return {
        width: bounds?.width() ?? 0,
        height: bounds?.height() ?? 0,
        layoutConfig,
        operators,
        edges,
        crossEdges,
        fragments,
        pipelines,
    };
}
