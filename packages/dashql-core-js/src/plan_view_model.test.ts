import * as dashql from './index.js';
import { loadCoreWasm } from './test_fixture.js';

let dql: dashql.DashQL | null = null;
beforeAll(async () => {
    const wasmBinary = await loadCoreWasm();
    dql = await dashql.DashQL.create({ wasmBinary });
    expect(dql).not.toBeNull();
});
afterEach(async () => {
    dql!.resetUnsafe();
});


const DEFAULT_LAYOUT_CONFIG = (() => {
    const config = new dashql.buffers.view.PlanLayoutConfigT();
    config.levelHeight = 64.0;
    config.nodeHeight = 32.0;
    config.nodeMarginHorizontal = 20.0;
    config.nodePaddingLeft = 8.0;
    config.nodePaddingRight = 8.0;
    config.iconWidth = 14.0;
    config.iconMarginRight = 8.0;
    config.maxLabelChars = 20;
    config.widthPerLabelChar = 8.5;
    config.nodeMinWidth = 0;
    return config;
})();

describe('Plan View Model', () => {
    describe('Hyper Plans', () => {
        it('invalid json should throw', () => {
            const viewModel = dql!.createPlanViewModel(DEFAULT_LAYOUT_CONFIG);
            expect(() => viewModel.loadHyperPlan("notavalidjson")).toThrow();
        });
        it('null input', () => {
            const viewModel = dql!.createPlanViewModel(DEFAULT_LAYOUT_CONFIG);
            const planPtr = viewModel.loadHyperPlan("null");
            expect(planPtr.read().operatorsLength()).toEqual(0);
        });
        it('empty json input', () => {
            const viewModel = dql!.createPlanViewModel(DEFAULT_LAYOUT_CONFIG);
            const planPtr = viewModel.loadHyperPlan("{}");
            expect(planPtr.read().operatorsLength()).toEqual(0);
        });
        it('parse tablescan', () => {
            const viewModel = dql!.createPlanViewModel(DEFAULT_LAYOUT_CONFIG);
            const planPtr = viewModel.loadHyperPlan(`
                {"operator":"executiontarget","operatorId":1,"cardinality":5,"producesRows":true,"output":[{"expression":"iuref","iu":["v",["Char",25]]}],"outputNames":["r_name"],"input":{"operator":"tablescan","operatorId":2,"sqlpos":[[41,47]],"cardinality":5,"relationId":9,"schema":{"type":"sessionschema"},"values":[{"name":"r_regionkey","type":["Integer"],"iu":null},{"name":"r_name","type":["Char",25],"iu":["v",["Char",25]]},{"name":"r_comment","type":["Varchar",152],"iu":null}],"debugName":{"classification":"nonsensitive","value":"region"},"selectivity":1}}
            `);
            const planReader = planPtr.read();
            expect(planReader.operatorsLength()).toEqual(2);
            expect(planReader.rootOperatorsLength()).toEqual(1);
            expect(planReader.rootOperators(0)).toEqual(1);
            expect(planReader.pipelinesLength()).toEqual(0);
            expect(planReader.stringDictionary(planReader.operators(1)!.operatorTypeName())).toEqual("executiontarget");
            expect(planReader.stringDictionary(planReader.operators(0)!.operatorTypeName())).toEqual("tablescan");
            const tableScan = planReader.operators(0)!;
            const properties: Record<string, unknown> = {};
            for (let i = 0; i < tableScan.attributeCount(); ++i) {
                const attribute = planReader.attributes(tableScan.attributesBegin() + i)!;
                properties[planReader.stringDictionary(attribute.name())!] = JSON.parse(planReader.stringDictionary(attribute.valueJson())!);
            }
            expect(properties.operatorId).toEqual(2);
            expect(properties.relationId).toEqual(9);
            expect(properties.values).toHaveLength(3);
            expect(properties).not.toHaveProperty('debugName.input');
        });
        it('parses explicit pipeline membership', () => {
            const viewModel = dql!.createPlanViewModel(DEFAULT_LAYOUT_CONFIG);
            const planPtr = viewModel.loadHyperPlan(`{
                "operator":"executiontarget","operatorId":1,
                "input":{"operator":"tablescan","operatorId":2},
                "pipelines":[{"pipelineId":10,"operators":[2,1]}]
            }`);
            const plan = planPtr.read();
            expect(plan.pipelinesLength()).toEqual(1);
            expect(plan.pipelines(0)!.operatorCount()).toEqual(2);
            expect(plan.pipelineOperators(plan.pipelines(0)!.operatorsBegin())).toEqual(0);
            expect(plan.pipelineOperators(plan.pipelines(0)!.operatorsBegin() + 1)).toEqual(1);
            expect(plan.pipelines(0)!.edgeCount()).toEqual(1);
            expect(plan.pipelineEdges(0)!.childOperator()).toEqual(0);
            expect(plan.pipelineEdges(0)!.parentOperator()).toEqual(1);
        });
        it('materializes operator cross edges', () => {
            const viewModel = dql!.createPlanViewModel(DEFAULT_LAYOUT_CONFIG);
            const planPtr = viewModel.loadHyperPlan(`{
                "operator":"unionall","operatorId":1,"input":[
                    {"operator":"join","operatorId":2,"left":{"operator":"tablescan","operatorId":3}},
                    {"operator":"tablescan","operatorId":4,"earlyProbes":[
                        {"builder":2,"attributes":[0],"type":"lookup"}
                    ]}
                ]
            }`);
            const plan = planPtr.read();
            expect(plan.operatorCrossEdgesLength()).toEqual(1);
            const edge = plan.operatorCrossEdges(0)!;
            expect(plan.operators(edge.sourceNode())!.crossEdgeCount()).toEqual(1);

        });
        it('creates fragments from federate descendants', () => {
            const viewModel = dql!.createPlanViewModel(DEFAULT_LAYOUT_CONFIG);
            const planPtr = viewModel.loadHyperPlan(`{
                "operator":"output",
                "inputs":[{
                    "operator":"federate",
                    "inputs":[{"operator":"map","input":{"operator":"scan"}}]
                }]
            }`);
            const plan = planPtr.read();
            expect(plan.fragmentsLength()).toEqual(1);
            const fragment = plan.fragments(0)!;
            expect(fragment.fragmentId()).toEqual(0);
            expect(fragment.anchorOperator()).toEqual(2);
            expect(fragment.operatorCount()).toEqual(3);
            expect(plan.fragmentOperators(fragment.operatorsBegin())).toEqual(2);
            expect(plan.fragmentOperators(fragment.operatorsBegin() + 1)).toEqual(1);
            expect(plan.fragmentOperators(fragment.operatorsBegin() + 2)).toEqual(0);
        });
        it('anchors a root fragment at the execution target', () => {
            const viewModel = dql!.createPlanViewModel(DEFAULT_LAYOUT_CONFIG);
            const planPtr = viewModel.loadHyperPlan(`{
                "operator":"executiontarget",
                "input":{"operator":"tablescan"}
            }`);
            const plan = planPtr.read();
            expect(plan.fragmentsLength()).toEqual(1);
            const fragment = plan.fragments(0)!;
            expect(fragment.anchorOperator()).toEqual(1);
            expect(fragment.operatorCount()).toEqual(2);
            expect(plan.fragmentOperators(fragment.operatorsBegin())).toEqual(1);
            expect(plan.fragmentOperators(fragment.operatorsBegin() + 1)).toEqual(0);
        });
        it('preserves estimated and analyzed output rows', () => {
            const viewModel = dql!.createPlanViewModel(DEFAULT_LAYOUT_CONFIG);
            const planPtr = viewModel.loadHyperPlan(`{
                "operator":"executiontarget","cardinality":100,
                "input":{
                    "operator":"tablescan","estimated-rows":80,
                    "statistics":{"output-rows":0}
                }
            }`);
            const plan = planPtr.read();
            const scan = plan.operators(0)!;
            const target = plan.operators(1)!;
            expect(scan.executionStatistics()!.outputCardinalityEstimated()).toEqual(80);
            expect(scan.executionStatistics()!.outputCardinalityProduced()).toEqual(0n);
            expect(target.executionStatistics()!.outputCardinalityEstimated()).toEqual(100);

            const properties: Record<string, unknown> = {};
            for (let i = 0; i < scan.attributeCount(); ++i) {
                const attribute = plan.attributes(scan.attributesBegin() + i)!;
                properties[plan.stringDictionary(attribute.name())!] = JSON.parse(plan.stringDictionary(attribute.valueJson())!);
            }
            expect(properties.statistics).toEqual({ 'output-rows': 0 });
        });
    });
});
