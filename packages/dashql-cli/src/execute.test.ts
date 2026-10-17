import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Executor } from './execute.js';
import { Linter } from './lint.js';

let executor: Executor;
beforeAll(async () => {
    executor = await Executor.create((await Linter.create()).core);
});
afterAll(async () => {
    await executor?.close();
});

const run = (text: string) => executor.execute(text);

describe('Executor', () => {
    it('counts the rows of a query', async () => {
        expect(await run('select * from generate_series(1, 5) as numbers(value);')).toMatchObject({ ok: true, statements: 1, rows: 5 });
    });

    it('prepares data and counts the rows of the final query', async () => {
        const result = await run(`
            create temporary table items (id integer, name text);
            insert into items values (1, 'a'), (2, 'b'), (3, 'c');
            delete from items where id = 3;
            select * from items order by id;
        `);
        expect(result).toMatchObject({ ok: true, statements: 4, rows: 2 });
    });

    it('runs the query of a trailing VISUALIZE', async () => {
        const result = await run(`
            create temporary table sales (category text, amount integer);
            insert into sales values ('a', 1), ('a', 2), ('b', 3);
            select category, sum(amount) as total from sales group by category
            visualize using vegalite (
                mark => bar,
                encoding => (x => (field => category, type => nominal), y => (field => total, type => quantitative))
            );
        `);
        expect(result).toMatchObject({ ok: true, statements: 3, rows: 2 });
    });

    it('reports no rows for scripts without a final query', async () => {
        expect(await run('create temporary table empty_table (id integer);')).toMatchObject({ ok: true, statements: 1 });
    });

    it('shares tables between scripts', async () => {
        await run('create table shared_items (id integer); insert into shared_items values (1);');
        expect(await run('select * from shared_items;')).toMatchObject({ ok: true, statements: 1, rows: 1 });
    });

    it('times dashql-core and every statement in Hyper', async () => {
        const result = await run('create temporary table timed (id integer);\ninsert into timed values (1);\nselect * from timed;');
        expect(result.timings.core).toBeGreaterThan(0);
        expect(result.timings.statements).toHaveLength(3);
        for (const statement of result.timings.statements) {
            expect(statement.wall).toBeGreaterThan(0);
            expect(statement.hyper?.execution).not.toBeNull();
        }
    });

    it('reports the failing statement with its SQL state', async () => {
        const result = await run('create temporary table other (id integer);\nselect * from missing_table;');
        expect(result).toMatchObject({ ok: false, statement: 2, sqlState: '42P01' });
        expect(result).toHaveProperty('message', expect.stringContaining('missing_table'));
    });

    it('reports scripts that do not compile', async () => {
        // Only the final statement may produce a result
        const result = await run('select 1; select 2;');
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('final statement') });
        expect(result).not.toHaveProperty('statement');
    });
});
