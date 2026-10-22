import { afterEach, describe, expect, it } from 'vitest';

import { CONNECTOR_INFOS, ConnectorType, useConnectorList } from './connector_info.js';

describe('connector list', () => {
    afterEach(() => {
        delete (globalThis as any).dashqlElectron;
    });

    it('shows the supported connectors in the browser', () => {
        expect(useConnectorList().map(info => info.connectorType)).toEqual([
            ConnectorType.HYPER,
            ConnectorType.SALESFORCE_DATA_CLOUD,
            ConnectorType.TRINO,
        ]);
    });

    it('shows the supported connectors in Electron', () => {
        (globalThis as any).dashqlElectron = {};
        expect(useConnectorList().map(info => info.connectorType)).toEqual([
            ConnectorType.HYPER,
            ConnectorType.SALESFORCE_DATA_CLOUD,
            ConnectorType.TRINO,
        ]);
        expect(useConnectorList()[0]).toBe(CONNECTOR_INFOS[ConnectorType.HYPER]);
    });
});

describe('connector hello world scripts', () => {
    it.each([
        [ConnectorType.HYPER, 'select version();'],
        [ConnectorType.SALESFORCE_DATA_CLOUD, 'select version();'],
        [ConnectorType.TRINO, 'select version();'],
    ])('defines an executable starter query for %s', (connectorType, expected) => {
        expect(CONNECTOR_INFOS[connectorType].helloWorldScript).toBe(expected);
    });
});
