import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connector_settings.module.css';

import {
    FileSymlinkFileIcon,
    KeyIcon,
    PlugIcon,
    XIcon,
} from '@primer/octicons-react';


import { Button, ButtonVariant } from '../foundations/button.js';
import { ConnectionHealth } from '../../connectors/connection_state.js';
import { Dispatch } from '../../utils/variant.js';
import { IndicatorStatus, StatusIndicator } from '../foundations/status_indicator.js';
import { KeyValueListBuilder, KeyValueListElement, UpdateKeyValueList } from '../foundations/keyvalue_list.js';
import { TextField } from '../foundations/text_field.js';
import { TrinoAuthParams, TrinoConnectionParams } from '../../connectors/trino/trino_connection_params.js';
import { classNames } from '../../utils/classnames.js';
import { getConnectionHealthIndicator, getConnectionStatusText } from './salesforce_connector_settings.js';
import { useConnectionState } from '../../connectors/connection_registry.js';
import { useCurrentSessionSelector } from '../../session/current_session.js';
import { useDefaultSessions } from '../../session/session_setup.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useSessionState } from '../../session/session_state_registry.js';
import { useTrinoSetup } from '../../connectors/trino/trino_connector.js';

const LOG_CTX = "trino_connector";

interface PageState {
    endpoint: string;
    authParams: TrinoAuthParams;
    additionalMetadata: KeyValueListElement[];
};
type PageStateSetter = Dispatch<React.SetStateAction<PageState>>;
const PAGE_STATE_CTX = React.createContext<[PageState, PageStateSetter] | null>(null);

export const TrinoConnectorSettings: React.FC = () => {
    const logger = useLogger();
    const trinoSetup = useTrinoSetup();

    // Get Trino connection from default session
    const defaultSessions = useDefaultSessions();
    const sessionId = defaultSessions?.trino ?? null;
    const [sessionState, _sessionDispatch] = useSessionState(sessionId);

    // Resolve connection for the default session
    const connectionId = sessionState?.connectionId ?? null;
    const [connectionState, dispatchConnectionState] = useConnectionState(connectionId);

    // Wire up the page state
    const [pageState, setPageState] = React.useContext(PAGE_STATE_CTX)!;
    const setEndpoint = (v: string) => setPageState(s => ({ ...s, endpoint: v }));
    const setBasicAuthUsername = (v: string) => setPageState(s => ({ ...s, authParams: { ...s.authParams, username: v } }));
    const setBasicAuthSecret = (v: string) => setPageState(s => ({ ...s, authParams: { ...s.authParams, secret: v } }));
    const modifyMetadata: Dispatch<UpdateKeyValueList> = (action: UpdateKeyValueList) => setPageState(s => ({ ...s, additionalMetadata: action(s.additionalMetadata) }));

    const setupAbortController = React.useRef<AbortController | null>(null);

    // Helper to setup the connection
    const setupConnection = async () => {
        // Is there a Trino client?
        if (trinoSetup == null) {
            logger.error("Trino connector is unavailable", LOG_CTX);
            return;
        }
        // Is there a connection id?
        if (connectionId == null) {
            logger.warn("Trino connection id is null", LOG_CTX);
            return;
        }

        try {
            // Setup the Trino connection
            setupAbortController.current = new AbortController();
            const connectionParams: TrinoConnectionParams = {
                channelArgs: {
                    endpoint: pageState.endpoint
                },
                authParams: pageState.authParams,
                metadata: pageState.additionalMetadata,
            };
            const _channel = await trinoSetup.setup(dispatchConnectionState, connectionParams, setupAbortController.current.signal);

            // Start the catalog update
            // XXX
        } catch (error: any) {
            // XXX
        }
        setupAbortController.current = null;
    };

    // Helper to cancel the authorization
    const cancelAuth = () => {
        if (setupAbortController.current) {
            setupAbortController.current.abort("abort the Hyper setup");
            setupAbortController.current = null;
        }
    };
    // Helper to reset the authorization
    const resetAuth = async () => {
        if (trinoSetup) {
            await trinoSetup.reset(dispatchConnectionState);
        }
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
    const indicatorStatus: IndicatorStatus = getConnectionHealthIndicator(connectionState?.connectionHealth ?? null);

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
                        <use xlinkHref={`${symbols}#trino`} />
                    </svg>
                </div>
                <div className={style.platform_name} aria-labelledby="connector-hyper-database">
                    Trino
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
                            name="Endpoint"
                            caption="Endpoint of the Trino Api as 'https://host:port'"
                            value={pageState.endpoint}
                            placeholder="trino endpoint url"
                            leadingVisual={() => <div>URL</div>}
                            onChange={(e) => setEndpoint(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Username"
                            className={style.grid_column_1}
                            caption="Username for the Trino Api"
                            value={pageState.authParams.username}
                            placeholder=""
                            leadingVisual={() => <div>ID</div>}
                            onChange={(e) => setBasicAuthUsername(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Secret"
                            caption="Password for the Trino Api"
                            value={pageState.authParams.secret}
                            placeholder=""
                            leadingVisual={KeyIcon}
                            onChange={(e) => setBasicAuthSecret(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            concealed={true}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <KeyValueListBuilder
                            title="Additional Metadata"
                            caption="Extra HTTP headers that are added to each request"
                            keyIcon={() => <div>Header</div>}
                            valueIcon={() => <div>Value</div>}
                            addButtonLabel="Add Header"
                            elements={pageState.additionalMetadata}
                            modifyElements={modifyMetadata}
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

export const TrinoConnectorSettingsStateProvider: React.FC<ProviderProps> = (props: ProviderProps) => {
    const state = React.useState<PageState>({
        endpoint: "http://localhost:8080",
        authParams: {
            username: "",
            secret: "",
        },
        additionalMetadata: [],
    });
    return (
        <PAGE_STATE_CTX.Provider value={state}>
            {props.children}
        </PAGE_STATE_CTX.Provider>
    );
};
