import { jest } from '@jest/globals';

import * as arrow from 'apache-arrow';
import { ArrowTableFormatter } from './arrow_formatter.js';

describe('TableFormatter', () => {
    it("can be constructed from a single column", () => {
        const LENGTH = 10;
        const testData = Int32Array.from(
            { length: LENGTH },
            () => Number((Math.random() * 20).toFixed(0)));
        const table = arrow.tableFromArrays({
            test: testData,
        });
        
        const formatter = new ArrowTableFormatter(table.schema, table.batches);
        expect(formatter.getValue(0, 0)).toEqual(testData[0].toString());
    });
});



