import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR, TRINO_CONNECTOR } from '../../connections/connector_info.js';
import { type ConnectionState } from '../../connections/connection_state.js';
import { connectionLabel, connectionLabelParts, connectionOrdinals } from '../../connections/ui/connection_label.js';
import type { ConnectionRegistry } from '../../connections/connection_registry.js';
import {
    connectionDisplayOrder,
    connectionTreeRowHeight,
    flattenCatalogRows,
    listedConnections,
    isConnectionInitiallyExpanded,
    isVisibleCatalogNode,
    type CatalogNode,
} from './session_workbench_sidebar.js';

describe('session workbench database labels', () => {
    it('labels the mandatory local database by its connector and Local', () => {
        const database = {
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
            details: {
                type: HYPER_CONNECTOR,
                value: { proto: { setupParams: { protocol: 'WASM' } } },
            },
        } as ConnectionState;

        expect(connectionLabel(database)).toBe('Hyper Local');
        expect(connectionLabelParts(database)).toEqual({ name: 'Hyper', connector: 'Hyper', named: false, detail: 'Local' });
    });

    it('keeps the connector and protocol label for remote Hyper databases', () => {
        const database = {
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
            details: {
                type: HYPER_CONNECTOR,
                value: { proto: { setupParams: { protocol: 'V3_HTTP' } } },
            },
        } as ConnectionState;

        expect(connectionLabel(database)).toBe('Hyper Http');
        expect(connectionLabelParts(database)).toEqual({ name: 'Hyper', connector: 'Hyper', named: false, detail: 'Http' });
    });

    it('renders Memory first and initially collapses it only when another database exists', () => {
        const memory = {
            connectionId: 'memory',
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
            details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'WASM' } } } },
        } as ConnectionState;
        const remote = {
            connectionId: 'remote',
            connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
            details: { type: TRINO_CONNECTOR, value: { proto: { setupParams: {} } } },
        } as ConnectionState;

        expect(connectionDisplayOrder({ main: remote, attached: [memory] }).map(database => database.connectionId))
            .toEqual(['remote', 'memory']);
        expect(isConnectionInitiallyExpanded(memory, 1)).toBe(true);
        expect(isConnectionInitiallyExpanded(memory, 2)).toBe(false);
        expect(isConnectionInitiallyExpanded(remote, 2)).toBe(true);
    });
});

describe('connections of the same connector', () => {
    const hyper = (connectionId: string, extra: Partial<ConnectionState> = {}) => ({
        connectionId,
        active: true,
        connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
        details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'V3_HTTP' } } } },
        ...extra,
    }) as ConnectionState;
    const trino = (connectionId: string) => ({
        connectionId,
        active: true,
        connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
        details: { type: TRINO_CONNECTOR, value: { proto: { setupParams: {} } } },
    }) as ConnectionState;
    const registryOf = (databases: ConnectionState[], sessions: Record<string, string[]> = {}) => {
        const connectionsByType: string[][] = [[], [], []];
        for (const database of databases) connectionsByType[database.connectorInfo.connectorType].push(database.connectionId);
        return {
            connections: new Map(databases.map(database => [database.connectionId, database])),
            connectionsByType,
            attachedDatabasesBySession: new Map(Object.entries(sessions).map(([sessionId, [main, ...attached]]) => [
                sessionId,
                { mainDatabaseId: main, attachedDatabaseIds: attached },
            ])),
        } as unknown as ConnectionRegistry;
    };

    it('numbers unnamed connections only when their connector repeats', () => {
        const registry = registryOf([hyper('a'), trino('t'), hyper('b')]);
        const ordinals = connectionOrdinals(registry, new Set());
        expect([...ordinals]).toEqual([['a', 1], ['b', 2]]);
        expect(connectionLabel(registry.connections.get('b')!, ordinals.get('b'))).toBe('Hyper #2 Http');
        expect(connectionLabel(registry.connections.get('t')!, ordinals.get('t') ?? null)).toBe('Trino Http');
    });

    it('labels named connections by their names and leaves them out of the numbering', () => {
        const named = hyper('a', { name: 'Production' });
        const registry = registryOf([named, hyper('b'), hyper('c')]);
        const ordinals = connectionOrdinals(registry, new Set());
        expect([...ordinals]).toEqual([['b', 1], ['c', 2]]);
        expect(connectionLabelParts(named)).toEqual({ name: 'Production', connector: 'Hyper', named: true, detail: 'Http' });
        expect(connectionLabel(named)).toBe('Production (Hyper Http)');
        expect(connectionOrdinals(registryOf([named, hyper('b')]), new Set()).size).toBe(0);
    });

    it('does not number connections that are not listed', () => {
        // The shell session is not part of the scripts registry, its connection is not listed
        const registry = registryOf([hyper('a'), hyper('shell'), hyper('b', { active: false })], { session: ['a'], shell: ['shell'] });
        expect(connectionOrdinals(registry, new Set(['session'])).size).toBe(0);
        expect(listedConnections(registry, new Set(['session']), []).map(database => database.connectionId)).toEqual(['a']);
    });

    it('sizes the group headings of the connection tree', () => {
        const rows = [
            { type: 'connection-group', key: 'g', label: 'This session' },
            { type: 'attached-database', key: 'a', database: hyper('a') },
        ] as any;
        expect(connectionTreeRowHeight(0, { rows })).toBeLessThan(connectionTreeRowHeight(1, { rows }));
    });
});

describe('session workbench catalog tree', () => {
    it('hides anonymous database and schema containers created by unqualified SQL declarations', () => {
        expect(isVisibleCatalogNode('database', '')).toBe(false);
        expect(isVisibleCatalogNode('schema', '   ')).toBe(false);
        expect(isVisibleCatalogNode('database', 'hyper')).toBe(true);
        expect(isVisibleCatalogNode('schema', 'public')).toBe(true);
    });

    it('reads descendants only when their parents are expanded', () => {
        const schemas = [{ nameId: () => 1, childBegin: () => 0, childCount: () => 2 }];
        const tables = [
            { nameId: () => 2, childBegin: () => 0, childCount: () => 0 },
            { nameId: () => 3, childBegin: () => 0, childCount: () => 0 },
        ];
        const reader = {
            readName: (id: number) => ['', 'public', 'accounts', 'contacts'][id],
            catalogReader: {
                databasesLength: () => 1,
                schemasLength: () => schemas.length,
                tablesLength: () => tables.length,
                columnsLength: () => 0,
                schemas: (index: number) => schemas[index],
                tables: (index: number) => tables[index],
                columns: () => null,
            },
        } as any;
        const database: CatalogNode = {
            key: 'catalog/database:0:hyper', name: 'hyper', kind: 'database', index: 0, childBegin: 0, childCount: 1,
        };

        const databaseOnly = flattenCatalogRows(reader, [database], new Set());
        expect(databaseOnly.map(row => row.name)).toEqual(['hyper']);
        expect(databaseOnly[0].type).toBe('catalog');

        const withSchema = flattenCatalogRows(reader, [database], new Set([database.key]));
        expect(withSchema.map(row => row.name)).toEqual(['hyper', 'public']);

        const withTables = flattenCatalogRows(reader, [database], new Set([database.key, withSchema[1].key]));
        expect(withTables.map(row => row.name)).toEqual(['hyper', 'public', 'accounts', 'contacts']);
    });
});
