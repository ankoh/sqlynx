import * as dashql from '@ankoh/dashql-core';

export class PlanExecutionController {
    private operatorSlots: Array<SVGGElement | null> = [];
    private pipelinePaths: Array<SVGPathElement | null> = [];
    private statuses = new Uint8Array();

    public reset(operatorCount: number, pipelineCount: number) {
        this.operatorSlots.length = operatorCount;
        this.pipelinePaths.length = pipelineCount;
        this.statuses = new Uint8Array(operatorCount);
        for (const slot of this.operatorSlots) {
            if (slot != null) slot.dataset.status = `${dashql.buffers.view.PlanExecutionStatus.UNKNOWN}`;
        }
        for (const path of this.pipelinePaths) {
            if (path != null) delete path.dataset.status;
        }
    }

    public registerOperator(id: number, slot: SVGGElement | null) {
        this.operatorSlots[id] = slot;
        if (slot != null) slot.dataset.status = `${this.statuses[id] ?? dashql.buffers.view.PlanExecutionStatus.UNKNOWN}`;
    }

    public registerPipeline(id: number, path: SVGPathElement | null) {
        this.pipelinePaths[id] = path;
    }

    public applyChangeEvents(events: dashql.buffers.view.PlanChangeEvents) {
        const operator = new dashql.buffers.view.UpdateOperatorEvent();
        const pipeline = new dashql.buffers.view.UpdatePipelineEvent();
        for (let i = 0; i < events.eventsLength(); ++i) {
            switch (events.eventsType(i)) {
                case dashql.buffers.view.PlanChangeEvent.UpdateOperatorEvent: {
                    const update = events.events(i, operator) as dashql.buffers.view.UpdateOperatorEvent;
                    const id = update.operatorId();
                    if (id >= this.statuses.length || this.statuses[id] === update.executionStatus()) break;
                    this.statuses[id] = update.executionStatus();
                    const slot = this.operatorSlots[id];
                    if (slot != null) slot.dataset.status = `${update.executionStatus()}`;
                    break;
                }
                case dashql.buffers.view.PlanChangeEvent.UpdatePipelineEvent: {
                    const update = events.events(i, pipeline) as dashql.buffers.view.UpdatePipelineEvent;
                    const path = this.pipelinePaths[update.pipelineId()];
                    if (path != null) path.dataset.status = `${update.executionStatus()}`;
                    break;
                }
            }
        }
    }
}
