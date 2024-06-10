import * as React from 'react';
import * as Immutable from 'immutable';

import { ChecklistIcon, DatabaseIcon, FileBadgeIcon, KeyIcon, PlugIcon } from '@primer/octicons-react';

import { classNames } from '../../utils/classnames.js';
import { KeyValueTextField, TextField } from '../base/text_field.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useHyperDatabaseClient } from '../../platform/hyperdb_client_provider.js';
import { KeyValueListBuilder, KeyValueListElement, UpdateKeyValueList } from '../base/keyvalue_list.js';
import { IndicatorStatus, StatusIndicator } from '../base/status_indicator.js';
import { Dispatch } from '../../utils/variant.js';
import {
    AttachedDatabase,
    HyperDatabaseChannel,
    HyperDatabaseConnectionContext,
} from '../../platform/hyperdb_client.js';
import { Button, ButtonVariant } from '../base/button.js';
import { useHyperGrpcConnectionId } from '../../connectors/hyper_grpc_connector.js';
import { useConnectionState } from '../../connectors/connection_registry.js';
import { asHyperGrpcConnection, ConnectionState } from '../../connectors/connection_state.js';
import {
    CHANNEL_READY,
    CHANNEL_SETUP_FAILED,
    CHANNEL_SETUP_STARTED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_SUCCEEDED,
    HyperGrpcConnectorAction,
    reduceHyperGrpcConnectorState,
} from '../../connectors/hyper_grpc_connection_state.js';
import { HYPER_GRPC_CONNECTOR } from '../../connectors/connector_info.js';
import { HyperGrpcConnectionParams } from '../../connectors/connection_params.js';
import { ConnectionHealth, ConnectionStatus } from '../../connectors/connection_status.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connector_settings.module.css';
import { Logger } from '../../platform/logger.js';

const LOG_CTX = "hyper_connector";

interface PageState {
    endpoint: string;
    mTlsKeyPath: string;
    mTlsPubPath: string;
    mTlsCaPath: string;
    attachedDatabases: Immutable.List<KeyValueListElement>;
    gRPCMetadata: Immutable.List<KeyValueListElement>;
};
type PageStateSetter = Dispatch<React.SetStateAction<PageState>>;
const PAGE_STATE_CTX = React.createContext<[PageState, PageStateSetter] | null>(null);

function getConnectionStatusText(status: ConnectionStatus | undefined, logger: Logger) {
    switch (status) {
        case ConnectionStatus.NOT_STARTED:
            return "Disconnected";
        case ConnectionStatus.CHANNEL_SETUP_STARTED:
            return "Creating channel";
        case ConnectionStatus.CHANNEL_SETUP_FAILED:
            return "Failed to create channel";
        case ConnectionStatus.CHANNEL_SETUP_CANCELLED:
            return "Cancelled channel setup";
        case ConnectionStatus.CHANNEL_READY:
            return "Channel is ready";
        case ConnectionStatus.HEALTH_CHECK_STARTED:
            return "Health check started";
        case ConnectionStatus.HEALTH_CHECK_FAILED:
            return "Health check failed";
        case ConnectionStatus.HEALTH_CHECK_CANCELLED:
            return "Health check cancelled";
        case ConnectionStatus.HEALTH_CHECK_SUCCEEDED:
            return "Health check succeeded";
        case undefined:
            break;
        default:
            logger.warn(`unexpected connection status: ${status}`);
    }
    return "";
}

export const HyperGrpcConnectorSettings: React.FC = () => {
    const logger = useLogger();
    const hyperClient = useHyperDatabaseClient();

    // Resolve Hyper connection state
    const connectionId = useHyperGrpcConnectionId();
    const [connectionState, setConnectionState] = useConnectionState(connectionId);
    const hyperConnection = asHyperGrpcConnection(connectionState);

    // Wire up the page state
    const [pageState, setPageState] = React.useContext(PAGE_STATE_CTX)!;
    const setEndpoint = (v: string) => setPageState(s => ({ ...s, endpoint: v }));
    const setMTLSKeyPath = (v: string) => setPageState(s => ({ ...s, mTlsKeyPath: v }));
    const setMTLSPubPath = (v: string) => setPageState(s => ({ ...s, mTlsPubPath: v }));
    const setMTLSCaPath = (v: string) => setPageState(s => ({ ...s, mTlsCaPath: v }));
    const modifyAttachedDbs: Dispatch<UpdateKeyValueList> = (action: UpdateKeyValueList) => setPageState(s => ({ ...s, attachedDatabases: action(s.attachedDatabases) }));
    const modifyGrpcMetadata: Dispatch<UpdateKeyValueList> = (action: UpdateKeyValueList) => setPageState(s => ({ ...s, gRPCMetadata: action(s.gRPCMetadata) }));

    const setupConnection = async () => {
        // Helper to dispatch actions against the connection state
        const modifyState = (action: HyperGrpcConnectorAction) => {
            setConnectionState((c: ConnectionState) => {
                const s = asHyperGrpcConnection(c)!;
                return {
                    type: HYPER_GRPC_CONNECTOR,
                    value: reduceHyperGrpcConnectorState(s, action)
                };
            });
        };

        // Is there a Hyper client
        if (hyperClient == null) {
            logger.error("Hyper client is unavailable", LOG_CTX);
            return;
        }

        // Collect the connection params
        const connectionParams: HyperGrpcConnectionParams = {
            channel: {
                endpoint: pageState.endpoint
            },
            attachedDatabases: pageState.attachedDatabases,
            gRPCMetadata: pageState.gRPCMetadata,
        };

        // Mark the setup as started
        modifyState({
            type: CHANNEL_SETUP_STARTED,
            value: connectionParams
        });
        let channel: HyperDatabaseChannel;
        try {
            logger.trace(`connecting to endpoint: ${pageState.endpoint}`, LOG_CTX);

            // Save the current gRPC metadata
            const metadata = pageState.gRPCMetadata;
            // Set up an ad-hoc connection for now
            const fakeConnection: HyperDatabaseConnectionContext = {
                getAttachedDatabases(): AttachedDatabase[] {
                    return [];
                },
                getRequestMetadata(): Promise<Record<string, string>> {
                    const headers: Record<string, string> = {};
                    for (const entry of metadata) {
                        headers[entry.key] = entry.value;
                    }
                    return Promise.resolve(headers);
                }
            };
            // Create a channel
            channel = await hyperClient.connect({
                endpoint: pageState.endpoint
            }, fakeConnection);
            modifyState({
                type: CHANNEL_READY,
                value: channel
            });
        } catch (e: any) {
            console.error(e);
            modifyState({
                type: CHANNEL_SETUP_FAILED,
                value: e.toString()!
            });
            logger.error(`channel setup failed with error: ${e.toString()}`, LOG_CTX);
            return;
        }

        // Check the channel health
        modifyState({
            type: HEALTH_CHECK_STARTED,
            value: null
        });
        const healthCheck = await channel.checkHealth();
        if (!healthCheck.ok) {
            modifyState({
                type: HEALTH_CHECK_FAILED,
                value: healthCheck.errorMessage!
            });
            logger.error(healthCheck.errorMessage!, LOG_CTX);
            return;
        }
        modifyState({
            type: HEALTH_CHECK_SUCCEEDED,
            value: null
        });

        // Close the channel
        // XXX Remove
        await channel.close();
    };

    // Get the connection status
    const statusText: string = getConnectionStatusText(hyperConnection?.connectionStatus, logger);

    // Get the indicator status
    let indicatorStatus: IndicatorStatus = IndicatorStatus.None;
    switch (hyperConnection?.connectionHealth) {
        case ConnectionHealth.NOT_STARTED:
            indicatorStatus = IndicatorStatus.None;
            break;
        case ConnectionHealth.ONLINE:
            indicatorStatus = IndicatorStatus.Succeeded;
            break;
        case ConnectionHealth.FAILED:
            indicatorStatus = IndicatorStatus.Failed;
            break;
        case ConnectionHealth.CONNECTING:
            indicatorStatus = IndicatorStatus.Running;
            break;
    }

    return (
        <div className={style.layout}>
            <div className={style.connector_header_container}>
                <div className={style.platform_logo}>
                    <svg width="28px" height="28px">
                        <use xlinkHref={`${symbols}#hyper`} />
                    </svg>
                </div>
                <div className={style.platform_name} aria-labelledby="connector-hyper-database">
                    Hyper Database
                </div>
                <div className={style.platform_actions}>
                    <Button
                        variant={ButtonVariant.Primary}
                        leadingVisual={PlugIcon}
                        onClick={setupConnection}
                    >Connect</Button>
                </div>
            </div >
            <div className={style.status_container}>
                <div className={classNames(style.section, style.status_section)}>
                    <div className={classNames(style.section_layout, style.status_section_layout)}>
                        <div className={style.status_bar}>
                            <div className={style.status_indicator}>
                                <StatusIndicator className={style.status_indicator_spinner} status={indicatorStatus} fill="black" />
                            </div>
                            <div className={style.status_text}>
                                {statusText}
                            </div>
                            <div className={style.status_stats}>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div className={style.body_container}>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="gRPC Endpoint"
                            caption="Endpoint of the gRPC service as 'https://host:port'"
                            value={pageState.endpoint}
                            placeholder="gRPC endpoint url"
                            leadingVisual={() => <div>URL</div>}
                            onChange={(e) => setEndpoint(e.target.value)}
                            disabled={false}
                            logContext={LOG_CTX}
                        />
                        <KeyValueTextField
                            className={style.grid_column_1}
                            name="mTLS Client Key"
                            caption="Paths to client key and client certificate"
                            k={pageState.mTlsKeyPath}
                            v={pageState.mTlsPubPath}
                            keyPlaceholder="client.key"
                            valuePlaceholder="client.pem"
                            keyIcon={KeyIcon}
                            valueIcon={FileBadgeIcon}
                            onChangeKey={(e) => setMTLSKeyPath(e.target.value)}
                            onChangeValue={(e) => setMTLSPubPath(e.target.value)}
                            disabled={false}
                            keyAriaLabel='mTLS Client Key'
                            valueAriaLabel='mTLS Client Certificate'
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="mTLS CA certificates"
                            caption="Path to certificate authority (CA) certificates"
                            value={pageState.mTlsCaPath}
                            placeholder="cacerts.pem"
                            leadingVisual={ChecklistIcon}
                            onChange={(e) => setMTLSCaPath(e.target.value)}
                            disabled={false}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <KeyValueListBuilder
                            className={style.grid_column_1}
                            title="Attached Databases"
                            caption="Databases that are attached for every query"
                            keyIcon={DatabaseIcon}
                            valueIcon={() => <div>ID</div>}
                            addButtonLabel="Add Database"
                            elements={pageState.attachedDatabases}
                            modifyElements={modifyAttachedDbs}
                        />
                        <KeyValueListBuilder
                            title="gRPC Metadata"
                            caption="Extra HTTP headers that are added to each request"
                            keyIcon={() => <div>Header</div>}
                            valueIcon={() => <div>Value</div>}
                            addButtonLabel="Add Header"
                            elements={pageState.gRPCMetadata}
                            modifyElements={modifyGrpcMetadata}
                        />
                    </div>
                </div>
            </div>
        </ div>
    );
};

interface ProviderProps { children: React.ReactElement };

export const HyperGrpcConnectorSettingsStateProvider: React.FC<ProviderProps> = (props: ProviderProps) => {
    const state = React.useState<PageState>({
        endpoint: "http://localhost:7484",
        mTlsKeyPath: "",
        mTlsPubPath: "",
        mTlsCaPath: "",
        attachedDatabases: Immutable.List(),
        gRPCMetadata: Immutable.List(),
    });
    return (
        <PAGE_STATE_CTX.Provider value={state}>
            {props.children}
        </PAGE_STATE_CTX.Provider>
    );
};
