import { peekFormat } from './format_peek.js';

describe('peekFormat', () => {
    it('returns null for null and short strings', () => {
        expect(peekFormat(null)).toBeNull();
        expect(peekFormat('')).toBeNull();
        expect(peekFormat('x')).toBeNull();
    });

    it('returns null for plain text', () => {
        expect(peekFormat('hello world')).toBeNull();
        expect(peekFormat('some ordinary value')).toBeNull();
        expect(peekFormat('123.45')).toBeNull();
    });

    it('detects json objects', () => {
        expect(peekFormat('{"key": "value"}')).toBe('json');
        expect(peekFormat('  {"key": 1}  ')).toBe('json');
        expect(peekFormat('{}')).toBe('json');
    });

    it('detects json arrays', () => {
        expect(peekFormat('[1, 2, 3]')).toBe('json');
        expect(peekFormat('  [{"a": 1}]  ')).toBe('json');
        expect(peekFormat('[]')).toBe('json');
    });

    it('requires closing bracket for json', () => {
        expect(peekFormat('{ incomplete')).toBeNull();
        expect(peekFormat('[no end')).toBeNull();
    });

    it('detects hyper plans', () => {
        expect(peekFormat('{"operator":"executiontarget","operatorId":1}')).toBe('plan');
        expect(peekFormat('  {"operator":"sort","cardinality":5}  ')).toBe('plan');
    });

    it('prefers plan over json when operator key present', () => {
        expect(peekFormat('{"operator":"join","left":{},"right":{}}')).toBe('plan');
    });

    it('detects large hyper plans', () => {
        const inputs = Array.from({ length: 20000 }, (_, i) => `{"operator":"tablescan","operator-id":${i}}`).join(',');
        const plan = `{"tree":{"operator":"result-sink","operator-id":0,"inputs":[${inputs}]}}  `;
        expect(plan.length).toBeGreaterThan(800000);
        expect(peekFormat(plan)).toBe('plan');
        expect(peekFormat(`${plan} trailing`)).toBeNull();
    });

    it('only looks for the operator key at the start of large values', () => {
        const value = `{"padding":"${'x'.repeat(10000)}","operator":"sort"}`;
        expect(peekFormat(value)).toBe('json');
    });

    it('detects sql keywords', () => {
        expect(peekFormat('SELECT * FROM t')).toBe('sql');
        expect(peekFormat('select 1')).toBe('sql');
        expect(peekFormat('  INSERT INTO t VALUES (1)')).toBe('sql');
        expect(peekFormat('UPDATE t SET x = 1')).toBe('sql');
        expect(peekFormat('DELETE FROM t')).toBe('sql');
        expect(peekFormat('CREATE TABLE t (id INT)')).toBe('sql');
        expect(peekFormat('ALTER TABLE t ADD COLUMN x INT')).toBe('sql');
        expect(peekFormat('DROP TABLE t')).toBe('sql');
        expect(peekFormat('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe('sql');
        expect(peekFormat('EXPLAIN SELECT 1')).toBe('sql');
        expect(peekFormat('COPY t FROM stdin')).toBe('sql');
        expect(peekFormat('BEGIN')).toBe('sql');
        expect(peekFormat('COMMIT')).toBe('sql');
        expect(peekFormat('ROLLBACK')).toBe('sql');
        expect(peekFormat('SET search_path TO public')).toBe('sql');
    });

    it('handles leading whitespace for sql', () => {
        expect(peekFormat('  SELECT 1')).toBe('sql');
        expect(peekFormat('\n\tSELECT 1')).toBe('sql');
    });

    it('does not match sql keywords mid-string', () => {
        expect(peekFormat('please SELECT something')).toBeNull();
    });
});
