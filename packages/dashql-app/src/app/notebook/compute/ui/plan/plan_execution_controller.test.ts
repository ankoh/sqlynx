import * as dashql from '@ankoh/dashql-core';
import { PlanExecutionController } from './plan_execution_controller.js';

describe('PlanExecutionController', () => {
    it('keeps mounted elements registered when execution state resets', () => {
        const controller = new PlanExecutionController();
        const operator = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const pipeline = document.createElementNS('http://www.w3.org/2000/svg', 'path');

        controller.reset(1, 1);
        controller.registerOperator(0, operator);
        controller.registerPipeline(0, pipeline);
        operator.dataset.status = `${dashql.buffers.view.PlanExecutionStatus.SUCCEEDED}`;
        pipeline.dataset.status = `${dashql.buffers.view.PlanExecutionStatus.SUCCEEDED}`;

        controller.reset(1, 1);

        expect(operator.dataset.status).toEqual(`${dashql.buffers.view.PlanExecutionStatus.UNKNOWN}`);
        expect(pipeline.dataset.status).toBeUndefined();
    });
});
