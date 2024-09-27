import * as arrow from 'apache-arrow';
import * as aq from 'arquero';


describe('Arquero', () => {
    it("filter batch", () => {
        const testData = new Int32Array([
            1, 2, 3, 4, 5, 6, 7, 8
        ]);
        const table = arrow.tableFromArrays({
            test: testData,
        });
        const t = aq.from(table);
        const out = t.filter(d => d!.test < 3)
            .objects();
        expect(out).toEqual([{
            test: 1,
        }, {
            test: 2
        }]);
    });

    it("filter TimestampMillisecond", () => {
        const schema = new arrow.Schema([
            new arrow.Field("time", new arrow.TimestampMillisecond(), false)
        ]);
        const data = new BigInt64Array(10);
        const now = new Date();
        for (let i = 0; i < data.length; ++i) {
            data[i] = BigInt(now.getTime() + 1000 * i);
        }
        const table = new arrow.Table(schema, {
            "time": arrow.makeVector(data)
        });
        const t = aq.from(table);
        const aggregated = t.filter(d => d!.time > 42)
            .rollup({
                time_min: d => aq.op.min(d!.time),
                time_max: d => aq.op.max(d!.time),
            })
            .object(0);
        const mapped = {
            time_min: new Date(Number((aggregated as any).time_min)),
            time_max: new Date(Number((aggregated as any).time_max))
        };
        expect(mapped).toEqual({
            time_min: new Date(Number(data[0])),
            time_max: new Date(Number(data[data.length - 1])),
        });
    });
});
