import * as arrow from 'apache-arrow';

import { generateRandomData, RandomDataConfig } from './random_data.js';

describe('RandomData', () => {
    it("empty", () => {
        const config: RandomDataConfig = {
            fields: [
                {
                    name: "some_field",
                    type: new arrow.Int32(),
                    nullable: false,
                    generateScalarValue: (i: number) => 42 + i
                }
            ],
            resultBatches: 1,
            resultRowsPerBatch: 0
        };
        const [schema, batches] = generateRandomData(config);
        expect(schema.fields.length).toEqual(1);
        expect(schema.fields[0].name).toEqual("some_field");
        expect(batches.length).toEqual(1);
        expect(batches[0].data.children[0].values.length).toEqual(0);
    });
    it("int32", () => {
        const config: RandomDataConfig = {
            fields: [
                {
                    name: "some_field",
                    type: new arrow.Int32(),
                    nullable: false,
                    generateScalarValue: (i: number) => 42 + i
                }
            ],
            resultBatches: 1,
            resultRowsPerBatch: 10
        };
        const [schema, batches] = generateRandomData(config);
        expect(schema.fields.length).toEqual(1);
        expect(schema.fields[0].name).toEqual("some_field");
        expect(batches.length).toEqual(1);
        expect(batches[0].data.children[0].values.length).toEqual(10);
        for (let i = 0; i < 10; ++i) {
            expect(batches[0].data.children[0].values[i]).toEqual(42 + i);
        }
    });
    it("nullable int32", () => {
        const config: RandomDataConfig = {
            fields: [
                {
                    name: "some_field",
                    type: new arrow.Int32(),
                    nullable: true,
                    generateScalarValue: (i) => (Math.random() <= 0.5) ? null : (42 + i)
                }
            ],
            resultBatches: 1,
            resultRowsPerBatch: 10
        };
        const [schema, batches] = generateRandomData(config);
        expect(schema.fields.length).toEqual(1);
        expect(schema.fields[0].name).toEqual("some_field");
        expect(batches.length).toEqual(1);
        expect(batches[0].data.children[0].values.length).toEqual(10);
        expect(batches[0].data.children[0].nullBitmap.length).toEqual(8);
        let nullCount = 0;
        for (let i = 0; i < 10; ++i) {
            const nullByte = i >> 3;
            const nullBit = i & 7;
            const nullMask = 1 << nullBit;
            const isNull = (batches[0].data.children[0].nullBitmap[nullByte] & nullMask) == 0;
            if (isNull) {
                ++nullCount
            } else {
                expect(batches[0].data.children[0].values[i]).toEqual(42 + i);
            }
        }
    });
    it("strings", () => {
        const config: RandomDataConfig = {
            fields: [
                {
                    name: "someField",
                    type: new arrow.Utf8(),
                    nullable: false,
                    generateScalarValue: (i) => `text/${42 + i}`
                }
            ],
            resultBatches: 1,
            resultRowsPerBatch: 4
        };
        const [schema, batches] = generateRandomData(config);
        const table = new arrow.Table(schema, batches);
        const objects = table.toArray().map(o => o.someField);
        expect(objects).toEqual([
            "text/42",
            "text/43",
            "text/44",
            "text/45",
        ]);
    });
    it("nullable strings", () => {
        const config: RandomDataConfig = {
            fields: [
                {
                    name: "someField",
                    type: new arrow.Utf8(),
                    nullable: true,
                    generateScalarValue: i => ((i % 2 == 0) ? null : `text/${42 + i}`)
                }
            ],
            resultBatches: 1,
            resultRowsPerBatch: 4
        };
        const [schema, batches] = generateRandomData(config);
        const table = new arrow.Table(schema, batches);
        expect(table.batches[0].data.children[0].values.length).toEqual(7 + 7);
        expect(table.batches[0].data.children[0].nullCount).toEqual(2);
        const objects = table.toArray().map(o => o.someField);
        expect(objects).toEqual([
            null,
            "text/43",
            null,
            "text/45",
        ]);
    });
    it("multiple scalar fields", () => {
        const config: RandomDataConfig = {
            fields: [
                {
                    name: "intField",
                    type: new arrow.Int32(),
                    nullable: false,
                    generateScalarValue: i => 42 + i
                },
                {
                    name: "intFieldNullable",
                    type: new arrow.Int32(),
                    nullable: true,
                    generateScalarValue: i => ((i % 2 == 0) ? null : (42 + i))
                },
                {
                    name: "stringField",
                    type: new arrow.Utf8(),
                    nullable: false,
                    generateScalarValue: i => `text/${42 + i}`
                },
                {
                    name: "stringFieldNullable",
                    type: new arrow.Utf8(),
                    nullable: true,
                    generateScalarValue: i => ((i % 2 == 0) ? null : `text/${42 + i}`)
                },
            ],
            resultBatches: 1,
            resultRowsPerBatch: 4
        };
        const [schema, batches] = generateRandomData(config);
        const table = new arrow.Table(schema, batches);
        const objects = table.toArray().map(o => ({
            intField: o.intField,
            intFieldNullable: o.intFieldNullable,
            stringField: o.stringField,
            stringFieldNullable: o.stringFieldNullable,
        }));
        expect(objects).toEqual([
            { intField: 42, intFieldNullable: null, stringField: `text/42`, stringFieldNullable: null },
            { intField: 43, intFieldNullable: 43, stringField: `text/43`, stringFieldNullable: `text/43` },
            { intField: 44, intFieldNullable: null, stringField: `text/44`, stringFieldNullable: null },
            { intField: 45, intFieldNullable: 45, stringField: `text/45`, stringFieldNullable: `text/45` },
        ]);
    });
    it("multiple batches", () => {
        const config: RandomDataConfig = {
            fields: [
                {
                    name: "some_field",
                    type: new arrow.Int32(),
                    nullable: false,
                    generateScalarValue: (i: number) => 42 + i
                }
            ],
            resultBatches: 10,
            resultRowsPerBatch: 20
        };
        const [schema, batches] = generateRandomData(config);
        expect(schema.fields.length).toEqual(1);
        expect(schema.fields[0].name).toEqual("some_field");
        expect(batches.length).toEqual(10);
        for (let i = 0; i < 10; ++i) {
            expect(batches[i].numRows).toEqual(20);
            for (let j = 0; j < 20; ++j) {
                expect(batches[i].data.children[0].values[j]).toEqual(42 + 20 * i + j);
            }
        }
    });
    it("lists", () => {
        const config: RandomDataConfig = {
            fields: [
                {
                    name: "listField",
                    type: new arrow.List(new arrow.Field(
                        "element",
                        new arrow.Float32(),
                        false
                    )),
                    nullable: false,
                    listElement: {
                        name: "element",
                        type: new arrow.Float32(),
                        nullable: false,
                        generateScalarValue: (i: number) => i,
                    },
                    listLength: (_i: number) => 5,
                }
            ],
            resultBatches: 1,
            resultRowsPerBatch: 4
        };
        const [schema, batches] = generateRandomData(config);
        expect(schema.fields.length).toEqual(1);
        expect(schema.fields[0].name).toEqual("listField");
        expect(batches.length).toEqual(1);

        const table = new arrow.Table(schema, batches);
        const objects = table.toArray().map(o => ({
            listField: [...o.listField]
        }));
        expect(objects).toEqual([
            { listField: [0, 1, 2, 3, 4] },
            { listField: [5, 6, 7, 8, 9] },
            { listField: [10, 11, 12, 13, 14] },
            { listField: [15, 16, 17, 18, 19] },
        ]);
    });
    it("lists nullable", () => {
        const config: RandomDataConfig = {
            fields: [
                {
                    name: "listField",
                    type: new arrow.List(new arrow.Field(
                        "element",
                        new arrow.Float32(),
                        false
                    )),
                    nullable: true,
                    listElement: {
                        name: "element",
                        type: new arrow.Float32(),
                        nullable: false,
                        generateScalarValue: (i: number) => i,
                    },
                    listLength: (i: number) => ((i % 2) == 0) ? null : 5,
                }
            ],
            resultBatches: 1,
            resultRowsPerBatch: 4
        };
        const [schema, batches] = generateRandomData(config);
        expect(schema.fields.length).toEqual(1);
        expect(schema.fields[0].name).toEqual("listField");
        expect(batches.length).toEqual(1);

        const table = new arrow.Table(schema, batches);
        const objects = table.toArray().map(o => ({
            listField: o.listField != null ? [...o.listField] : null
        }));
        expect(objects).toEqual([
            { listField: null },
            { listField: [0, 1, 2, 3, 4] },
            { listField: null },
            { listField: [5, 6, 7, 8, 9] },
        ]);
    });
});
