import * as dashql from '@ankoh/dashql-core';

import * as styles from './timeline_renderer.module.css';

const SVG_NS = "http://www.w3.org/2000/svg";

export class PlanPipelineRenderer {
    /// The pipeline path
    pipelinePath: SVGPathElement | null;
    /// The pipeline count
    pipelineCount: number;
    /// The pipeline started at
    pipelineStartedAt: bigint;
    /// The total duration in milliseconds
    pipelineDuration: bigint;
    /// The earliest pipeline begin
    earliestPipelineBegin: bigint;
    /// The earliest pipeline begin
    latestPipelineEnd: bigint;

    constructor() {
        this.pipelinePath = null;
        this.pipelineCount = 0;
        this.pipelineStartedAt = BigInt(0);
        this.pipelineDuration = BigInt(0);
        this.earliestPipelineBegin = BigInt(0);
        this.latestPipelineEnd = BigInt(0);
    }

    prepare(_renderer: PlanTimelineRenderer, vm: dashql.buffers.view.PlanViewModel, p: dashql.buffers.view.PlanPipeline, tmpStats: dashql.buffers.view.PlanExecutionStatistics, earliestPipelineBegin: bigint, latestPipelineEnd: bigint) {
        this.pipelineCount = vm.pipelinesLength();
        const pipelineStats = p.executionStatistics(tmpStats)!;
        this.pipelineStartedAt = pipelineStats.startedAt();
        this.pipelineDuration = (pipelineStats.finishedAt() > this.pipelineStartedAt) ? pipelineStats.finishedAt() : this.pipelineStartedAt;
        this.earliestPipelineBegin = earliestPipelineBegin;
        this.latestPipelineEnd = latestPipelineEnd;
    }
    render(renderer: PlanTimelineRenderer) {
        if (renderer.state == null) {
            return renderer.state
        }
        const totalDuration = this.latestPipelineEnd - this.earliestPipelineBegin;
        if (totalDuration == BigInt(0)) {
            return;
        }
        const fractionalStart = (this.pipelineStartedAt - this.earliestPipelineBegin) / totalDuration;
        const fractionalDuration = this.pipelineDuration / totalDuration;

        this.pipelinePath = document.createElementNS(SVG_NS, 'rect');
        this.pipelinePath.setAttribute("x", `${fractionalStart}%`);
        this.pipelinePath.setAttribute("y", `0`);
        this.pipelinePath.setAttribute("width", `${fractionalDuration}%`);
        this.pipelinePath.setAttribute("height", `100%`);
        this.pipelinePath.setAttribute("background", "red");
        renderer.state.pipelineNodes.appendChild(this.pipelinePath);

    }
}

export interface PlanTimelineRenderingState {
    /// The root ndoe
    rootNode: HTMLDivElement;
    /// The root center node
    rootContainer: SVGElement;
    /// The pipelines nodes
    pipelineNodes: SVGGElement;
}

export class PlanTimelineRenderer {
    /// The div where we add the root node as child
    mountPoint: HTMLDivElement | null = null;
    /// The current renderer output (if rendered)
    state: PlanTimelineRenderingState | null = null;
    /// The plan pipelines
    pipelines: PlanPipelineRenderer[] = [];
    /// The cursor bar (vertical line following the cursor)
    cursorBar: SVGPathElement | null = null;

    /// Constructor
    constructor() { }
    /// Reset the renderer
    public reset() {
        this.pipelines = [];
        this.cursorBar = null;
        if (this.state != null) {
            this.state.rootNode.remove();
            this.state = null;
        }
    }
    /// Mount the renderer to a node
    public mountTo(root: HTMLDivElement) {
        const prev = this.mountPoint;
        this.mountPoint = root;

        // Mount if the mount point changed and we rendered the root
        if (this.mountPoint != prev && this.mountPoint != null && this.state != null) {
            this.mountToUnsafe();
        }
    }
    // Mount with previous checks that everything is not null
    protected mountToUnsafe() {
        this.mountPoint!.appendChild(this.state!.rootNode);

        // Setup mouse event listener to log cursor position and update cursor bar
        this.state!.rootContainer.addEventListener('mousemove', (event: MouseEvent) => {
            const rect = this.state!.rootContainer.getBoundingClientRect();
            const x = event.clientX - rect.left;

            // Update cursor bar position and make it visible
            if (this.cursorBar) {
                const height = rect.height;
                this.cursorBar.setAttribute('d', `M ${x} 0 L ${x} ${height}`);
                this.cursorBar.style.visibility = 'visible';
            }
        });

        // Hide cursor bar when mouse leaves the SVG
        this.state!.rootContainer.addEventListener('mouseleave', () => {
            if (this.cursorBar) {
                this.cursorBar.style.visibility = 'hidden';
            }
        });
    }

    /// Render the plan
    public render(viewModel: dashql.FlatBufferPtr<dashql.buffers.view.PlanViewModel>) {
        this.reset();
        const vm = viewModel.read();

        // Collect pipelines
        for (let i = 0; i < vm.pipelinesLength(); ++i) {
            this.pipelines.push(new PlanPipelineRenderer());
        }

        // Prepare pipelines
        const tmpPipeline = new dashql.buffers.view.PlanPipeline();
        const tmpStats = new dashql.buffers.view.PlanExecutionStatistics();
        let earliestPipelineBegin: bigint | null = null;
        let latestPipelineEnd: bigint | null = null;
        for (let i = 0; i < vm.pipelinesLength(); ++i) {
            const pipelineVM = vm.pipelines(i, tmpPipeline)!;
            const pipelineStats = pipelineVM.executionStatistics(tmpStats)!;
            const pipelineBegin = pipelineStats.startedAt();
            const pipelineEnd = pipelineStats.finishedAt();
            earliestPipelineBegin = ((earliestPipelineBegin == null) || (earliestPipelineBegin > pipelineBegin)) ? pipelineBegin : earliestPipelineBegin;
            latestPipelineEnd = ((latestPipelineEnd == null) || (latestPipelineEnd > pipelineBegin)) ? pipelineEnd : latestPipelineEnd;
        }
        for (let i = 0; i < vm.pipelinesLength(); ++i) {
            const pipelineVM = vm.pipelines(i, tmpPipeline)!;
            const pipeline = this.pipelines[i];
            pipeline.prepare(this, vm, pipelineVM, tmpStats, earliestPipelineBegin!, latestPipelineEnd!);
        }

        // Construct rendering state
        if (this.state == null) {
            const rootNode = document.createElement("div");
            const rootSvgContainer = document.createElementNS(SVG_NS, 'svg');
            const pipelineNodes = document.createElementNS(SVG_NS, 'g');
            rootSvgContainer.style.width = '100%';
            rootSvgContainer.style.height = '100%';
            rootSvgContainer.appendChild(pipelineNodes);
            rootNode.className = styles.root;
            rootNode.appendChild(rootSvgContainer);

            this.state = {
                rootNode,
                rootContainer: rootSvgContainer,
                pipelineNodes
            };
        }

        // Setup cursor bar
        this.cursorBar = document.createElementNS(SVG_NS, 'path');
        this.cursorBar.setAttribute('stroke', 'black');
        this.cursorBar.setAttribute('stroke-width', '2');
        this.cursorBar.setAttribute('fill', 'none');
        this.cursorBar.setAttribute('d', '');
        this.cursorBar.style.visibility = 'hidden';
        this.state.rootContainer.appendChild(this.cursorBar);

        // Invoke the renderers
        for (const pipeline of this.pipelines) {
            pipeline.render(this);
        }

        // Do we already have a mount point? Then add the root node
        if (this.mountPoint != null) {
            this.mountToUnsafe();
        }
    }
}
