import { describe, expect, it } from 'vitest';
import { statementTexts } from './statements.js';
import { analyzeOne } from '../test_fixture.js';

describe('statementTexts', () => {
    it('drops comments around statements and keeps the statements', async () => {
        const sql = `-- lead\nselect a /* inline */ from t; -- trailing\n\n/* block */\nselect 2;\nselect 'ü'`;
        expect(statementTexts(await analyzeOne(sql))).toEqual(['select a /* inline */ from t', 'select 2', "select 'ü'"]);
    });

    it('is empty for scripts without statements', async () => {
        expect(statementTexts(await analyzeOne('-- nothing here'))).toEqual([]);
        expect(statementTexts(await analyzeOne(''))).toEqual([]);
    });
});
