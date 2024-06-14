import * as React from 'react';
import * as Immutable from 'immutable';
import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connector_settings.module.css';

import {
    ChecklistIcon,
    DatabaseIcon,
    FileBadgeIcon,
    FileSymlinkFileIcon,
    KeyIcon,
    PlugIcon,
    XIcon,
} from '@primer/octicons-react';

import { classNames } from '../../utils/classnames.js';
import { KeyValueTextField, TextField } from '../foundations/text_field.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useHyperDatabaseClient } from '../../platform/hyperdb_client_provider.js';
import { KeyValueListBuilder, KeyValueListElement, UpdateKeyValueList } from '../foundations/keyvalue_list.js';
import { IndicatorStatus, StatusIndicator } from '../foundations/status_indicator.js';
import { Dispatch } from '../../utils/variant.js';
import {
    AttachedDatabase,
    HyperDatabaseChannel,
    HyperDatabaseConnectionContext,
} from '../../platform/hyperdb_client.js';
import { Button, ButtonVariant } from '../foundations/button.js';
import { useConnectionState } from '../../connectors/connection_registry.js';
import {
    ConnectionHealth,
    ConnectionStatus,
    RESET,
} from '../../connectors/connection_state.js';
import {
    CHANNEL_READY,
    CHANNEL_SETUP_FAILED,
    CHANNEL_SETUP_STARTED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_SUCCEEDED,
} from '../../connectors/hyper_grpc_connection_state.js';
import { HyperGrpcConnectionParams } from '../../connectors/connection_params.js';
import { useSessionState, useSessionRegistry } from '../../session/session_state_registry.js';
import { useCurrentSessionSelector } from '../../session/current_session.js';
import { useNavigate } from 'react-router-dom';
import { Logger } from '../../platform/logger.js';
import { useDefaultSessions } from '../../session/session_setup.js';

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

    // Get Hyper connection from default session
    const defaultSessions = useDefaultSessions();
    const sessionId = defaultSessions?.hyper ?? null;
    const [sessionState, _sessionDispatch] = useSessionState(sessionId);

    // Resolve connection for the default session
    const connectionId = sessionState?.connectionId ?? null;
    const [connectionState, dispatchConnectionState] = useConnectionState(connectionId);

    // Wire up the page state
    const [pageState, setPageState] = React.useContext(PAGE_STATE_CTX)!;
    const setEndpoint = (v: string) => setPageState(s => ({ ...s, endpoint: v }));
    const setMTLSKeyPath = (v: string) => setPageState(s => ({ ...s, mTlsKeyPath: v }));
    const setMTLSPubPath = (v: string) => setPageState(s => ({ ...s, mTlsPubPath: v }));
    const setMTLSCaPath = (v: string) => setPageState(s => ({ ...s, mTlsCaPath: v }));
    const modifyAttachedDbs: Dispatch<UpdateKeyValueList> = (action: UpdateKeyValueList) => setPageState(s => ({ ...s, attachedDatabases: action(s.attachedDatabases) }));
    const modifyGrpcMetadata: Dispatch<UpdateKeyValueList> = (action: UpdateKeyValueList) => setPageState(s => ({ ...s, gRPCMetadata: action(s.gRPCMetadata) }));

    // Helper to setup the connection
    const setupConnection = async () => {
        // Is there a Hyper client?
        if (hyperClient == null) {
            logger.error("Hyper client is unavailable", LOG_CTX);
            return;
        }
        // Is there a connection id?
        if (connectionId == null) {
            logger.warn("Hyper connection id is null", LOG_CTX);
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
        dispatchConnectionState({
            type: CHANNEL_SETUP_STARTED,
            value: connectionParams
        });
        let channel: HyperDatabaseChannel;
        try {
            logger.debug(`connecting to endpoint: ${pageState.endpoint}`, LOG_CTX);

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
            dispatchConnectionState({
                type: CHANNEL_READY,
                value: channel
            });
        } catch (e: any) {
            console.error(e);
            dispatchConnectionState({
                type: CHANNEL_SETUP_FAILED,
                value: e.toString()!
            });
            logger.error(`channel setup failed with error: ${e.toString()}`, LOG_CTX);
            return;
        }

        // Check the channel health
        dispatchConnectionState({
            type: HEALTH_CHECK_STARTED,
            value: null
        });
        const healthCheck = await channel.checkHealth();
        if (!healthCheck.ok) {
            dispatchConnectionState({
                type: HEALTH_CHECK_FAILED,
                value: healthCheck.errorMessage!
            });
            logger.error(healthCheck.errorMessage!, LOG_CTX);
            return;
        }
        dispatchConnectionState({
            type: HEALTH_CHECK_SUCCEEDED,
            value: null
        });

        // Close the channel
        // XXX Remove
        await channel.close();
    };

    // Helper to cancel the authorization
    const cancelAuth = () => {
        // XXX
        // if (authAbortController.current) {
        //     authAbortController.current.abort("abort the authorization flow");
        //     authAbortController.current = null;
        // }
    };
    // Helper to reset the authorization
    const resetAuth = () => {
        dispatchConnectionState({ type: RESET, value: null });
    };

    // Helper to switch to the editor
    const selectCurrentSession = useCurrentSessionSelector();
    const navigate = useNavigate()
    const switchToEditor = React.useCallback(() => {
        if (sessionId != null) {
            selectCurrentSession(sessionId);
            navigate("/editor");
        }
    }, [sessionId]);

    // Get the connection status
    const statusText: string = getConnectionStatusText(connectionState?.connectionStatus, logger);

    // Get the indicator status
    let indicatorStatus: IndicatorStatus = IndicatorStatus.None;
    switch (connectionState?.connectionHealth) {
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

    // Get the action button
    let connectButton: React.ReactElement = <div />;
    let freezeInput = false;
    switch (connectionState?.connectionHealth) {
        case ConnectionHealth.NOT_STARTED:
        case ConnectionHealth.FAILED:
            connectButton = <Button variant={ButtonVariant.Primary} leadingVisual={PlugIcon} onClick={setupConnection}>Connect</Button>;
            break;
        case ConnectionHealth.CONNECTING:
            connectButton = <Button variant={ButtonVariant.Danger} leadingVisual={XIcon} onClick={cancelAuth}>Cancel</Button>;
            freezeInput = true;
            break;
        case ConnectionHealth.ONLINE:
            connectButton = <Button variant={ButtonVariant.Danger} leadingVisual={XIcon} onClick={resetAuth}>Disconnect</Button>;
            freezeInput = true;
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
                    {(connectionState?.connectionHealth == ConnectionHealth.ONLINE) && (
                        <Button variant={ButtonVariant.Default} leadingVisual={FileSymlinkFileIcon} onClick={switchToEditor}>Open Editor</Button>
                    )}
                    {connectButton}
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
                            disabled={freezeInput}
                            readOnly={freezeInput}
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
                            keyAriaLabel='mTLS Client Key'
                            valueAriaLabel='mTLS Client Certificate'
                            logContext={LOG_CTX}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                        />
                        <TextField
                            name="mTLS CA certificates"
                            caption="Path to certificate authority (CA) certificates"
                            value={pageState.mTlsCaPath}
                            placeholder="cacerts.pem"
                            leadingVisual={ChecklistIcon}
                            onChange={(e) => setMTLSCaPath(e.target.value)}
                            logContext={LOG_CTX}
                            disabled={freezeInput}
                            readOnly={freezeInput}
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
                            disabled={freezeInput}
                            readOnly={freezeInput}
                        />
                        <KeyValueListBuilder
                            title="gRPC Metadata"
                            caption="Extra HTTP headers that are added to each request"
                            keyIcon={() => <div>Header</div>}
                            valueIcon={() => <div>Value</div>}
                            addButtonLabel="Add Header"
                            elements={pageState.gRPCMetadata}
                            modifyElements={modifyGrpcMetadata}
                            disabled={freezeInput}
                            readOnly={freezeInput}
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
