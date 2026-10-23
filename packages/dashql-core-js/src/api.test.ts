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

describe('DashQL setup', () => {
    it('instantiates WebAssembly module', async () => {
        expect(dql).not.toBeNull();
        expect(dql).not.toBeUndefined();
    });

    it('copies FlatBuffer strings from shared Wasm memory before decoding them', () => {
        const decoder = dql!.decoder;
        const nativeDecoder = new TextDecoder();
        dql!.decoder = {
            decode(input?: AllowSharedBufferSource) {
                if (ArrayBuffer.isView(input) && input.buffer instanceof SharedArrayBuffer) {
                    throw new TypeError('The provided ArrayBufferView value must not be shared');
                }
                return nativeDecoder.decode(input);
            },
        } as TextDecoder;

        try {
            const catalog = dql!.createCatalog();
            const script = dql!.createScript(catalog);
            script.replaceText('CREATE TABLE foo(a INT)');
            script.analyze();
            const analyzed = script.getAnalyzed();
            try {
                const table = analyzed.read().tables(0);
                expect(table?.tableName()?.tableName()).toBe('foo');
                expect(table?.tableColumns(0)?.columnName()).toBe('a');
            } finally {
                analyzed.destroy();
            }
        } finally {
            dql!.decoder = decoder;
        }
    });

});

describe('DashQL planner', () => {
    const execution = dashql.buffers.execution;
    const absent = 0xffffffff;

    function resolvedTables(session: dashql.DashQLScriptSession) {
        return session.analyze().semanticSpans.filter(span =>
            span.kind === dashql.buffers.editor.EditorSemanticReferenceKind.TABLE &&
            span.resolution === dashql.buffers.editor.EditorSemanticResolution.RESOLVED);
    }

    function prepare(catalog: dashql.DashQLCatalog, sql: string, rank = 0, publish = false): dashql.DashQLScriptSession {
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, sql);
        expect(session.analyze().analysisAvailable).toBe(true);
        session.loadIntoCatalog(rank);
        if (!publish) {
            // Dropping forces analysis to refresh past the publication's catalog revision.
            session.dropFromCatalog();
            session.analyze();
        }
        return session;
    }

    it('returns an owned empty graph', () => {
        const result = dql!.plan([]);
        const reader = result.read(new execution.ExecutionGraph());
        expect(reader.valid()).toBe(true);
        expect(reader.nodesLength()).toBe(0);
        expect(reader.scriptsLength()).toBe(0);
        expect(reader.entitiesLength()).toBe(0);
        expect(reader.unresolvedReferencesLength()).toBe(0);
        expect(reader.edgesLength()).toBe(0);
        expect(reader.diagnosticsLength()).toBe(0);
        expect(dql!.registeredMemory.size).toBe(0);
        result.destroy();
        result.destroy();
        expect(result.isNull()).toBe(true);
        expect(dql!.registeredMemory.size).toBe(0);
    });

    it('preserves script order, source SQL, revisions, and independent reads', () => {
        const catalog = dql!.createCatalog();
        prepare(catalog, 'create table a (id int); create table b (id int)', 0, true);
        const first = prepare(catalog, '-- description\nselect * from a; select * from b;', 20);
        const second = prepare(catalog, 'select 1; select * from a;', 10);
        // Refresh earlier sessions after all publications, without changing their documents.
        const tables = resolvedTables(first);
        second.analyze();
        const version = first.getCatalogRevision();
        const state = first.getStateRevision();
        const result = dql!.plan([second, first]);
        const graph = result.read().unpack();
        expect(graph.valid).toBe(true);
        expect(graph.diagnostics).toEqual([]);
        expect(graph.edges).toEqual([]);
        expect(graph.scripts.map(script => [script.scriptId, script.textVersion])).toEqual([
            [second.catalog_entry_id, 1n], [first.catalog_entry_id, 1n],
        ]);
        expect(graph.scripts.every(script => script.analyzedCatalogRevision === version)).toBe(true);
        expect(graph.scripts.every(script => typeof script.analyzedTextVersion === 'bigint' &&
            script.analyzedTextVersion === script.textVersion)).toBe(true);
        expect(graph.nodes.map(node => [node.script, node.statementId, node.sql])).toEqual([
            [0, 0, 'select 1'], [0, 1, 'select * from a'],
            [1, 0, 'select * from a'], [1, 1, 'select * from b'],
        ]);
        expect(graph.nodes.every(node => node.producesOutput && !node.barrier)).toBe(true);
        expect(graph.entities.map(entity => entity.name).sort()).toEqual(['a', 'b']);
        expect(graph.unresolvedReferences).toEqual([]);
        expect(tables).toHaveLength(2);
        for (const table of tables) {
            const entity = graph.entities.find(entity => entity.catalogObjectId?.objectId === table.catalogTableId)!;
            expect(typeof table.catalogTableId).toBe('bigint');
            expect(table.catalogTableId).toBeGreaterThan(0xffffffffn);
            expect(entity).toBeDefined();
            expect(entity.catalogObjectId).toEqual(new execution.ExecutionGraphCatalogObjectIDT(
                execution.ExecutionGraphEntityType.TABLE, table.catalogTableId, 0,
            ));
            expect(entity.catalogDatabaseId).toBe(table.catalogDatabaseId);
            expect(entity.catalogSchemaId).toBe(table.catalogSchemaId);
            expect(entity.databaseName).toBeNull();
            expect(entity.schemaName).toBeNull();
            const packed = result.read().entities(graph.entities.indexOf(entity))!.catalogObjectId()!;
            expect(packed.objectType()).toBe(execution.ExecutionGraphEntityType.TABLE);
            expect(packed.objectId()).toBe(table.catalogTableId);
            expect(packed.subObjectId()).toBe(0);
        }
        for (const node of graph.nodes) {
            for (const access of node.accesses) {
                expect(access.entity).toBeLessThan(graph.entities.length);
                expect(access.unresolvedReference).toBe(absent);
                expect(access.mode).toBe(execution.ExecutionGraphAccessMode.READ);
            }
        }
        expect(first.getCatalogRevision()).toBe(version);
        expect(first.getStateRevision()).toBe(state);
        expect(dql!.plan([second, first]).unpackAndDestroy()).toEqual(graph);
        result.destroy();
    });

    it('packs DDL and read/write conflicts across sessions', () => {
        const catalog = dql!.createCatalog();
        const create = prepare(catalog, 'create table a (id int)', 0, true);
        const reads = prepare(catalog, 'select * from a; select * from a', 1);
        const writes = prepare(catalog,
            'insert into a values (1); select * from a; insert into a values (2) returning id', 2);
        create.analyze();
        const [table] = resolvedTables(reads);
        writes.analyze();
        const graph = dql!.plan([create, reads, writes]).unpackAndDestroy() as
            dashql.buffers.execution.ExecutionGraphT;
        expect(graph.valid).toBe(true);
        expect(graph.nodes).toHaveLength(6);
        expect(graph.entities).toHaveLength(1);
        expect(graph.unresolvedReferences).toEqual([]);
        expect(graph.entities[0].catalogObjectId).toEqual(new execution.ExecutionGraphCatalogObjectIDT(
            execution.ExecutionGraphEntityType.TABLE, table.catalogTableId, 0,
        ));
        expect(typeof graph.entities[0].catalogObjectId!.objectId).toBe('bigint');
        expect(dashql.ExternalObjectID.getOrigin(table.catalogTableId)).toBe(create.catalog_entry_id);
        for (const node of graph.nodes) {
            expect(node.accesses).toHaveLength(1);
            expect(node.accesses[0].entity).toBe(0);
            expect(node.accesses[0].unresolvedReference).toBe(absent);
        }
        for (const edge of graph.edges) {
            expect(edge.entity).toBe(0);
            expect(edge.unresolvedReference).toBe(absent);
        }
        const edges = graph.edges.map(edge => [edge.from, edge.to, edge.reason]);
        expect(edges).toEqual(expect.arrayContaining([
            [0, 1, execution.ExecutionGraphEdgeReason.DDL],
            [0, 2, execution.ExecutionGraphEdgeReason.DDL],
            [1, 3, execution.ExecutionGraphEdgeReason.WRITE_AFTER_READ],
            [2, 3, execution.ExecutionGraphEdgeReason.WRITE_AFTER_READ],
            [3, 4, execution.ExecutionGraphEdgeReason.READ_AFTER_WRITE],
            [3, 5, execution.ExecutionGraphEdgeReason.WRITE_AFTER_WRITE],
            [4, 5, execution.ExecutionGraphEdgeReason.WRITE_AFTER_READ],
        ]));
        expect(edges.some(([from, to]) => from === 1 && to === 2)).toBe(false);
        expect(graph.nodes[0].accesses[0].mode).toBe(execution.ExecutionGraphAccessMode.DDL);
        expect(graph.nodes[3].producesOutput).toBe(false);
        expect(graph.nodes[5].producesOutput).toBe(true);
    });

    it.each([false, true])('keeps external/participating declaration identities across drop/recreate (participating=%s)', participating => {
        const catalog = dql!.createCatalog();
        const create = prepare(catalog, 'create table db.s.a (id int); select * from db.s.a', 0, true);
        const use = prepare(catalog,
            'select * from db.s.a; drop table a; create table db.s.a (id int); select * from db.s.a', 1);
        const [oldTable] = resolvedTables(create);
        const tables = resolvedTables(use);
        const newTable = tables[tables.length - 1];
        const graph = dql!.plan(participating ? [create, use] : [use]).unpackAndDestroy() as
            dashql.buffers.execution.ExecutionGraphT;
        expect(graph.valid).toBe(true);
        expect(graph.diagnostics).toEqual([]);
        expect(graph.entities).toHaveLength(2);
        expect(graph.unresolvedReferences).toEqual([]);
        const offset = participating ? 2 : 0;
        const oldEntity = graph.nodes[offset].accesses[0].entity;
        const newEntity = graph.nodes[offset + 2].accesses[0].entity;
        expect(oldEntity).not.toBe(newEntity);
        expect(oldTable.catalogTableId).not.toBe(newTable.catalogTableId);
        expect(dashql.ExternalObjectID.getOrigin(oldTable.catalogTableId)).toBe(create.catalog_entry_id);
        expect(dashql.ExternalObjectID.getOrigin(newTable.catalogTableId)).toBe(use.catalog_entry_id);
        for (const [index, table] of [[oldEntity, oldTable], [newEntity, newTable]] as const) {
            const entity = graph.entities[index];
            expect(typeof entity.catalogObjectId!.objectId).toBe('bigint');
            expect(entity.catalogObjectId).toEqual(new execution.ExecutionGraphCatalogObjectIDT(
                execution.ExecutionGraphEntityType.TABLE, table.catalogTableId, 0,
            ));
            expect(entity.catalogDatabaseId).toBe(table.catalogDatabaseId);
            expect(entity.catalogSchemaId).toBe(table.catalogSchemaId);
            expect([entity.databaseName, entity.schemaName, entity.name]).toEqual(['db', 's', 'a']);
        }
        expect(graph.nodes.map(node => node.accesses[0].entity)).toEqual(
            participating ? [oldEntity, oldEntity, oldEntity, oldEntity, newEntity, newEntity] :
                [oldEntity, oldEntity, newEntity, newEntity],
        );
        for (const node of graph.nodes) {
            expect(node.accesses).toHaveLength(1);
            expect(node.accesses[0].unresolvedReference).toBe(absent);
        }
        expect(graph.nodes[offset + 1].accesses[0].mode).toBe(execution.ExecutionGraphAccessMode.DDL);
        expect(graph.nodes[offset + 2].accesses[0].mode).toBe(execution.ExecutionGraphAccessMode.DDL);
        for (const edge of graph.edges) {
            expect(edge.reason).toBe(execution.ExecutionGraphEdgeReason.DDL);
            expect(edge.entity).toBe(graph.nodes[edge.to].accesses[0].entity);
            expect(edge.unresolvedReference).toBe(absent);
        }
        expect(graph.edges.map(edge => [edge.from, edge.to, edge.entity])).toEqual(expect.arrayContaining([
            [offset, offset + 1, oldEntity],
            [offset + 1, offset + 2, newEntity],
            [offset + 2, offset + 3, newEntity],
        ]));
        if (participating) {
            expect(graph.edges.map(edge => [edge.from, edge.to, edge.entity])).toContainEqual([0, 1, oldEntity]);
        }
    });

    it('uses unresolved references and barrier sentinels without synthetic entities', () => {
        const session = prepare(dql!.createCatalog(),
            'select 1; select * from db.s.missing; drop table db.s.missing; select 2');
        const result = dql!.plan([session]);
        const reader = result.read();
        expect(reader.entitiesLength()).toBe(0);
        expect(reader.unresolvedReferencesLength()).toBe(1);
        expect(reader.nodes(1)?.accesses(0)?.entity()).toBe(absent);
        expect(reader.nodes(1)?.accesses(0)?.unresolvedReference()).toBe(0);
        const graph = result.unpackAndDestroy() as dashql.buffers.execution.ExecutionGraphT;
        expect(graph.valid).toBe(true);
        expect(graph.entities).toEqual([]);
        expect(graph.unresolvedReferences.map(reference =>
            [reference.databaseName, reference.schemaName, reference.name])).toEqual([['db', 's', 'missing']]);
        expect(graph.nodes.map(node => node.barrier)).toEqual([false, true, true, false]);
        expect(graph.nodes[0].accesses).toEqual([]);
        expect(graph.nodes[3].accesses).toEqual([]);
        for (const [index, mode] of [[1, execution.ExecutionGraphAccessMode.READ],
            [2, execution.ExecutionGraphAccessMode.DDL]] as const) {
            expect(graph.nodes[index].accesses).toEqual([new execution.ExecutionGraphAccessT(absent, 0, mode)]);
        }
        expect(graph.diagnostics.some(diagnostic => diagnostic.message?.includes('unresolved relation'))).toBe(true);
        expect(graph.diagnostics.some(diagnostic => diagnostic.message?.includes('unresolved DROP'))).toBe(true);
        expect(graph.edges.map(edge => [edge.from, edge.to])).toEqual(expect.arrayContaining([[0, 1], [1, 2], [2, 3]]));
        for (const edge of graph.edges) {
            expect(edge.entity).toBe(absent);
            if (edge.reason === execution.ExecutionGraphEdgeReason.BARRIER) {
                expect(edge.unresolvedReference).toBe(absent);
            } else {
                expect([edge.from, edge.to, edge.reason, edge.unresolvedReference]).toEqual(
                    [1, 2, execution.ExecutionGraphEdgeReason.DDL, 0],
                );
            }
        }
        expect(graph.edges.some(edge => edge.reason === execution.ExecutionGraphEdgeReason.DDL)).toBe(true);
    });

    it('does not analyze or publish missing or edited analysis', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 'select 1');
        const version = session.getCatalogRevision();
        const missing = dql!.plan([session]).unpackAndDestroy();
        expect(missing.valid).toBe(false);
        expect(missing.nodes).toEqual([]);
        expect(missing.diagnostics[0].message).toContain('missing or stale');
        expect(session.getCatalogRevision()).toBe(version);
        expect(catalog.containsEntryId(session.catalog_entry_id)).toBe(false);
        session.analyze();
        session.loadIntoCatalog(0);
        session.replaceText(1n, 'select 2');
        const stale = dql!.plan([session]).unpackAndDestroy();
        expect(stale.valid).toBe(false);
        expect(stale.nodes).toEqual([]);
        session.analyze();
        const refreshed = dql!.plan([session]).unpackAndDestroy();
        expect(refreshed.valid).toBe(true);
        expect(refreshed.scripts[0].textVersion).toBe(2n);
        expect(refreshed.scripts[0].analyzedTextVersion).toBe(refreshed.scripts[0].textVersion);
        expect(refreshed.nodes[0].sql).toBe('select 2');
    });

    it('reports mixed native catalogs and duplicates as graph diagnostics', () => {
        const first = prepare(dql!.createCatalog(), 'select 1');
        const second = prepare(dql!.createCatalog(), 'select 2');
        for (const [sessions, message] of [
            [[first, second], 'different catalogs'], [[first, first], 'duplicate'],
        ] as const) {
            const graph = dql!.plan(sessions).unpackAndDestroy();
            expect(graph.valid).toBe(false);
            expect(graph.nodes).toEqual([]);
            expect(graph.diagnostics.some((diagnostic: dashql.buffers.execution.ExecutionGraphDiagnosticT) =>
                diagnostic.message?.includes(message))).toBe(true);
        }
    });

    it('reports catalog-stale analysis without refreshing it automatically', () => {
        const catalog = dql!.createCatalog();
        const session = prepare(catalog, 'select 1');
        prepare(catalog, 'create table added (id int)', 1, true);
        const revision = session.getCatalogRevision();
        const state = session.getStateRevision();
        const stale = dql!.plan([session]).unpackAndDestroy();
        expect(stale.valid).toBe(false);
        expect(stale.nodes).toEqual([]);
        expect(stale.diagnostics.some((diagnostic: dashql.buffers.execution.ExecutionGraphDiagnosticT) =>
            diagnostic.message?.includes('catalog'))).toBe(true);
        expect(session.getCatalogRevision()).toBe(revision);
        expect(session.getStateRevision()).toBe(state);
        session.analyze();
        const refreshed = dql!.plan([session]).unpackAndDestroy();
        expect(refreshed.valid).toBe(true);
        expect(refreshed.scripts[0].analyzedCatalogRevision).toBe(revision);
        expect(refreshed.nodes[0].sql).toBe('select 1');
    });

    it('plans large session arrays and frees the native session list', () => {
        const session = prepare(dql!.createCatalog(), 'select 1');
        const baseline = dql!.registeredMemory.size;
        const free = vi.spyOn(dql!.bindings.SessionList.prototype, 'free');
        try {
            const result = dql!.plan(new Array(300000).fill(session));
            expect(result.read().valid()).toBe(false);
            expect(result.read().nodesLength()).toBe(0);
            expect(result.read().diagnostics(0)?.message()).toContain('duplicate');
            expect(free).toHaveBeenCalledTimes(1);
            expect(dql!.registeredMemory.size).toBe(baseline);
        } finally {
            free.mockRestore();
        }
    });

    it('rejects foreign, destroyed, null, and non-session inputs before entering native code', () => {
        const session = prepare(dql!.createCatalog(), 'select 1');
        const other = new dashql.DashQL(dql!.bindings);
        expect(other).not.toBe(dql);
        const foreign = other.createScriptSession(other.createCatalog());
        const plan = vi.spyOn(dql!.bindings, 'plan');
        try {
            expect(() => dql!.plan([session, foreign])).toThrow('different DashQL instance');
            session.destroy();
            expect(() => dql!.plan([session])).toThrow(dashql.NULL_POINTER_EXCEPTION);
            for (const input of [null, undefined, {}, [null], [undefined], [{}], new Array(1)]) {
                expect(() => dql!.plan(input as any)).toThrow(TypeError);
            }
            expect(plan).not.toHaveBeenCalled();
        } finally {
            plan.mockRestore();
            other.resetUnsafe();
        }
    });

    it('owns detached graph bytes and preserves unpacked data after release', () => {
        const catalog = dql!.createCatalog();
        const session = prepare(catalog, 'select 1');
        const first = dql!.plan([session]);
        const second = dql!.plan([session]);
        expect(first.equals(second)).toBe(false);
        expect(dql!.registeredMemory.size).toBe(2);
        session.replaceText(1n, 'select 2');
        session.destroy();
        catalog.destroy();
        expect(dql!.registeredMemory.size).toBe(0);
        expect(first.read().nodes(0)?.sql()).toBe('select 1');
        const unpacked = first.unpackAndDestroy();
        expect(first.isNull()).toBe(true);
        dql!.resetUnsafe();
        expect(second.read().nodes(0)?.sql()).toBe('select 1');
        expect(unpacked.nodes[0].sql).toBe('select 1');
        expect(unpacked.scripts[0].textVersion).toBe(1n);
        expect(unpacked.scripts[0].analyzedTextVersion).toBe(unpacked.scripts[0].textVersion);
    });

    it('frees the native session list when planning throws', () => {
        const session = prepare(dql!.createCatalog(), 'select 1');
        const baseline = dql!.registeredMemory.size;
        const plan = vi.spyOn(dql!.bindings, 'plan').mockImplementation(() => {
            throw new Error('test failure');
        });
        const free = vi.spyOn(dql!.bindings.SessionList.prototype, 'free');
        try {
            expect(() => dql!.plan([session])).toThrow('test failure');
            expect(free).toHaveBeenCalledTimes(1);
            expect(dql!.registeredMemory.size).toBe(baseline);
        } finally {
            plan.mockRestore();
            free.mockRestore();
        }
    });
});

describe('DashQL editor sessions', () => {
    const formattingConfig = () => new dashql.buffers.formatting.FormattingConfigT(
        dashql.buffers.formatting.FormattingDialect.HYPER,
        dashql.buffers.formatting.FormattingMode.INLINE,
        80,
        4,
    );

    it('allocates entry ids that are unique across catalogs', () => {
        const first = dql!.createCatalog();
        const second = dql!.createCatalog();
        const a = dql!.createScriptSession(first);
        const b = dql!.createScriptSession(second);
        expect(a.getCatalogEntryId()).not.toBe(b.getCatalogEntryId());
        b.destroy();
        a.destroy();
        second.destroy();
        first.destroy();
    });

    it('moves a script session into another catalog under its entry id', () => {
        const first = dql!.createCatalog();
        const second = dql!.createCatalog();
        const original = dql!.createScriptSession(first);
        const entryId = original.getCatalogEntryId();
        original.replaceText(0n, 'create table foo(a int)');
        original.analyze();
        original.loadIntoCatalog(entryId);
        // The entry id is in use in the first catalog
        expect(() => dql!.createScriptSessionWithEntryId(first, entryId)).toThrow();
        // An id that no catalog allocated is refused
        expect(() => dql!.createScriptSessionWithEntryId(second, 0xFFFFFF)).toThrow();
        const moved = dql!.createScriptSessionWithEntryId(second, entryId);
        expect(moved.getCatalogEntryId()).toBe(entryId);
        moved.destroy();
        original.destroy();
        second.destroy();
        first.destroy();
    });

    it('owns and destroys the native session', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);

        expect(session.getText()).toBe('');
        expect(session.getCatalogEntryId()).toBe(session.catalog_entry_id);
        expect(session.getTextVersion()).toBe(0n);
        expect(session.getStateRevision()).toBe(0n);
        expect(dql!.registeredMemory.size).toBe(2);

        const update = session.replaceText(0n, 'select 1');
        expect(update.status).toBe(dashql.buffers.editor.EditorUpdateStatus.OK);
        expect(update.textVersion).toBe(1n);
        expect(session.getTextVersion()).toBe(update.textVersion);
        expect(dql!.registeredMemory.size).toBe(2);

        session.destroy();
        expect(dql!.registeredMemory.size).toBe(1);
        expect(() => session.getText()).toThrow(dashql.NULL_POINTER_EXCEPTION);
        session.destroy();
        catalog.destroy();
    });

    it('rejects stale text versions without changing session state', () => {
        const session = dql!.createScriptSession(dql!.createCatalog());
        session.replaceText(0n, 'select 1');
        const snapshot = session.setCursor(1n, 8n);
        const event = new dashql.buffers.editor.EditorEventT(
            0n,
            [new dashql.buffers.editor.EditorTextChangeT(7n, 8n, '2')],
            new dashql.buffers.editor.EditorSelectionT(0n, 0n),
        );

        for (const update of [session.replaceText(0n, 'select 2'), session.setCursor(0n, 0n), session.apply(event)]) {
            expect(update.status).toBe(dashql.buffers.editor.EditorUpdateStatus.STALE_TEXT_VERSION);
            expect(update.textVersion).toBe(snapshot.textVersion);
            expect(update.stateRevision).toBe(snapshot.stateRevision);
            expect(update.primarySelection).toEqual(snapshot.primarySelection);
            expect(update.analysisAvailable).toBe(snapshot.analysisAvailable);
        }
        expect(session.getText()).toBe('select 1');
        expect(session.getTextVersion()).toBe(1n);
        expect(session.getStateRevision()).toBe(snapshot.stateRevision);
        const unchanged = session.replaceText(1n, 'select 1');
        expect(unchanged.status).toBe(dashql.buffers.editor.EditorUpdateStatus.OK);
        expect(unchanged.textVersion).toBe(1n);
    });

    it('applies a Unicode batch in pre-change UTF-16 offsets', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 'aéz');
        const event = new dashql.buffers.editor.EditorEventT(
            1n,
            [
                new dashql.buffers.editor.EditorTextChangeT(1n, 2n, '☃'),
                new dashql.buffers.editor.EditorTextChangeT(3n, 3n, '!'),
            ],
            new dashql.buffers.editor.EditorSelectionT(4n, 4n),
            dashql.buffers.editor.EditorEventOrigin.USER,
            dashql.buffers.editor.EditorEventIntent.EDIT,
            dashql.buffers.editor.EditorEventAction.TYPE,
            false,
        );

        const update = session.apply(event);

        expect(update.status).toBe(dashql.buffers.editor.EditorUpdateStatus.OK);
        expect(update.offsetUnit).toBe(dashql.buffers.editor.EditorOffsetUnit.UTF16_CODE_UNITS);
        expect(update.textChanged).toBe(true);
        expect(update.selectionChanged).toBe(true);
        expect(update.primarySelection?.head).toBe(4n);
        expect(session.getText()).toBe('a☃z!');
        expect(session.getTextVersion()).toBe(2n);
    });

    it('clamps an insertion past the document end', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 'a😀');
        const event = new dashql.buffers.editor.EditorEventT(
            1n,
            [new dashql.buffers.editor.EditorTextChangeT(100n, 100n, '!')],
            null,
            dashql.buffers.editor.EditorEventOrigin.USER,
            dashql.buffers.editor.EditorEventIntent.EDIT,
            dashql.buffers.editor.EditorEventAction.PASTE,
            false,
        );

        expect(session.apply(event).status).toBe(dashql.buffers.editor.EditorUpdateStatus.OK);
        expect(session.getText()).toBe('a😀!');
    });

    it('publishes portable analysis and cursor state', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        const text = 'create table items (id int); select * from items;';
        session.replaceText(0n, text);
        const cursorUpdate = session.setCursor(1n, BigInt(text.length));

        const update = session.analyze();
        expect(update.status).toBe(dashql.buffers.editor.EditorUpdateStatus.OK);
        expect(cursorUpdate.analysisUpdated).toBe(true);
        expect(update.analysisUpdated).toBe(false);
        expect(update.analysisAvailable).toBe(true);
        expect(session.getStateRevision()).toBe(2n);
        expect(session.getCatalogRevision()).toBe(update.catalogRevision);

        expect(update.scriptAnnotations?.tableDefinitions).toHaveLength(1);
        expect(update.primaryCursorState?.textOffset).toBe(BigInt(text.length));
        expect(update.processingStatistics?.ropeBytes).toBeGreaterThan(0n);
        expect(dql!.registeredMemory.size).toBe(2);
    });

    it('completes at the session cursor', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 's');
        session.setCursor(1n, 1n);
        session.analyze();

        const completion = session.completeAtCursor(10);
        expect(completion.read().candidates(0)?.completionText()).toBe('select');
        completion.destroy();
    });

    it('compiles, formats, and diffs the session script', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 'select 1 as value');
        session.analyze();

        const config = formattingConfig();
        const compilation = session.compileQuery(config);
        expect(compilation.read().sql()).toBe('select 1 as value');
        expect(compilation.read().errorsLength()).toBe(0);
        expect(compilation.read().cacheable()).toBe(true);
        expect(compilation.read().cacheSignature()).toMatch(/^[0-9a-f]{32}$/);
        compilation.destroy();

        expect(session.isFullyFormattable(config)).toBe(true);
        const formatted = session.format(config);
        expect(formatted.toString()).toBe('select 1 as value;');

        const target = dql!.createScript(catalog);
        target.replaceText('select 2 as value');
        target.parse();
        const diff = session.computeDiff(target);
        expect(diff.read().opsLength()).toBe(1);
        expect(diff.read().ops(0)?.code()).toBe(dashql.buffers.diff.ScriptDiffOpCode.UPDATE);

        diff.destroy();
        target.destroy();
        formatted.destroy();
    });

    it('loads and drops the session-owned script from its catalog', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 'create table items (id int)');
        session.analyze();

        expect(catalog.containsEntryId(session.catalog_entry_id)).toBeFalsy();
        session.loadIntoCatalog(17);
        expect(catalog.containsEntryId(session.catalog_entry_id)).toBeTruthy();
        session.dropFromCatalog();
        expect(catalog.containsEntryId(session.catalog_entry_id)).toBeFalsy();

        session.loadIntoCatalog(23);
        session.destroy();
        expect(catalog.containsEntryId(session.catalog_entry_id)).toBeFalsy();
    });
});

describe('ContextObjectChildID', () => {
    it('create child ids', () => {
        const parentId = dashql.ExternalObjectID.create(1234, 5678);
        const childId = dashql.ContextObjectChildID.create(parentId, 91011);
        expect(childId).not.toEqual(parentId);
        expect(dashql.ContextObjectChildID.getParent(childId)).toEqual(parentId);
        expect(dashql.ContextObjectChildID.getChild(childId)).toEqual(91011);
        expect(childId.toString()).toEqual("22763282211344411091843");
    });
});
