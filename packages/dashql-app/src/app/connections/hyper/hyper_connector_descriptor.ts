import type { ConnectorDescriptor } from '../connector_descriptor.js';
import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR } from '../connector_info.js';
import { DEFAULT_DATABASE_NAME } from '../catalog_sql_generator.js';
import { createHyperConnectionStateDetails, reduceHyperConnectorState } from './hyper_connection_state.js';

/// The default schema of Hyper
const HYPER_DEFAULT_SCHEMA = 'public';

/// Direct-to-Hyper connections
export const HYPER_CONNECTOR_DESCRIPTOR: ConnectorDescriptor<'hyper'> = {
    info: CONNECTOR_INFOS[ConnectorType.HYPER],
    paramsKey: 'hyper',
    detailsType: HYPER_CONNECTOR,
    defaultParams: () => ({ protocol: 'WASM', endpoint: '', tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' } }),
    createDetails: createHyperConnectionStateDetails,
    reduce: reduceHyperConnectorState,
    withoutDraftRows: ({ draftRows: _rows, ...params }) => params,
    sanitizeForSharing(params) {
        // Arbitrary headers and query parameters may carry credentials under any name.
        const { metadata: _metadata, queryParameters: _queryParameters, ...hyper } = params;
        return { ...hyper, tls: { clientKeyPath: "", clientCertPath: "", caCertsPath: "" } };
    },
    loginHint: () => null,
    cacheSignature: params => ({
        case: "hyper",
        protocol: params.protocol,
        channelArgs: {
            endpoint: params.endpoint,
            tls: params.tls
        },
        attachedDatabases: (params.attachedDatabases || [])
            .map((d: any) => ({ path: d.path, alias: d.alias }))
            .sort((a: any, b: any) => a.path > b.path ? 1 : -1),
        gRPCMetadata: params.metadata ? Object.entries(params.metadata).sort(([a,], [b]) => a > b ? 1 : -1) : [],
        queryParameters: params.queryParameters ? Object.entries(params.queryParameters).sort(([a,], [b]) => a > b ? 1 : -1) : []
    }),
    catalogNameDefaults(details) {
        // Unqualified names resolve against the first attached database
        const attached = details.proto.setupParams?.attachedDatabases ?? [];
        const databaseName = attached.length > 0 ? (attached[0].alias ?? '') : DEFAULT_DATABASE_NAME;
        return { databaseName, schemaName: HYPER_DEFAULT_SCHEMA };
    },
};
