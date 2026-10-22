import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR, TRINO_CONNECTOR } from '../../connections/connector_info.js';
import { type ConnectionState } from '../../connections/connection_state.js';
import { connectionLabel } from '../../connections/ui/connection_label.js';
import {
    connectionDisplayOrder,
    flattenCatalogRows,
    isConnectionInitiallyExpanded,
    isVisibleCatalogNode,
    type CatalogNode,
} from './session_workbench_sidebar.js';

describe('session workbench database labels', () => {
    it('labels the mandatory local database as Memory', () => {
        const database = {
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
            details: {
                type: HYPER_CONNECTOR,
                value: { proto: { setupParams: { protocol: 'WASM' } } },
            },
        } as ConnectionState;

        expect(connectionLabel(database)).toBe('Memory');
    });

    it('keeps the connector and protocol label for remote Hyper databases', () => {
        const database = {
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
            details: {
                type: HYPER_CONNECTOR,
                value: { proto: { setupParams: { protocol: 'V3_HTTP' } } },
            },
        } as ConnectionState;

        expect(connectionLabel(database)).toBe('Hyper / HTTP');
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
