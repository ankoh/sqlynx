import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connection_settings.module.css';

import {
    FileSymlinkFileIcon,
    KeyIcon,
    LinkIcon,
    PlugIcon,
    XIcon,
} from '@primer/octicons-react';

import { Button, ButtonSize, ButtonVariant } from '../foundations/button.js';
import { ConnectionHealth } from '../../connection/connection_state.js';
import { CopyToClipboardButton } from '../../utils/clipboard.js';
import { Dispatch } from '../../utils/variant.js';
import { IndicatorStatus, StatusIndicator } from '../foundations/status_indicator.js';
import { KeyValueListBuilder, UpdateKeyValueList } from '../foundations/keyvalue_list.js';
import { PlatformType, usePlatformType } from '../../platform/platform_type.js';
import { TextField } from '../foundations/text_field.js';
import { TrinoConnectionParams } from '../../connection/trino/trino_connection_params.js';
import { classNames } from '../../utils/classnames.js';
import { generateWorkbookUrl, WorkbookLinkTarget } from '../../workbook/workbook_setup_url.js';
import { getConnectionError, getConnectionHealthIndicator, getConnectionStatusText } from '../connection/salesforce_connector_settings.js';
import { useConnectionState } from '../../connection/connection_registry.js';
import { useCurrentWorkbookSelector } from '../../workbook/current_workbook.js';
import { useDefaultWorkbooks } from '../../workbook/workbook_setup.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useTrinoSetup } from '../../connection/trino/trino_connector.js';
import { useWorkbookState } from '../../workbook/workbook_state_registry.js';
import { ConnectionParamsVariant } from '../../connection/connection_params.js';
import { TRINO_CONNECTOR } from '../../connection/connector_info.js';
import { DetailedError } from '../../utils/error.js';
import { ErrorDetailsButton } from '../error_details.js';
import { useCatalogLoaderQueueFn } from '../../connection/catalog_loader.js';

const LOG_CTX = "trino_connector";

interface PageState {
    activeParams: TrinoConnectionParams | null;
    newParams: TrinoConnectionParams;
};
type PageStateSetter = Dispatch<React.SetStateAction<PageState>>;
const PAGE_STATE_CTX = React.createContext<[PageState, PageStateSetter] | null>(null);

export const TrinoConnectorSettings: React.FC = () => {
    const logger = useLogger();
    const trinoSetup = useTrinoSetup();

    // Get Trino connection from default session
    const defaultWorkbooks = useDefaultWorkbooks();
    const workbookId = defaultWorkbooks?.trino ?? null;
    const [workbook, _modifyWorkbook] = useWorkbookState(workbookId);

    // Resolve connection for the default workbook
    const connectionId = workbook?.connectionId ?? null;
    const [connectionState, dispatchConnectionState] = useConnectionState(connectionId);

    // Resolve the catalog loader
    const loadCatalog = useCatalogLoaderQueueFn();

    // Wire up the page state
    const [pageState, setPageState] = React.useContext(PAGE_STATE_CTX)!;
    const setEndpoint = (v: string) => setPageState(s => ({ ...s, newParams: { ...s.newParams, channelArgs: { ...s.newParams.channelArgs, endpoint: v } } }));
    const setBasicAuthUsername = (v: string) => setPageState(s => ({ ...s, newParams: { ...s.newParams, authParams: { ...s.newParams.authParams, username: v } } }));
    const setBasicAuthSecret = (v: string) => setPageState(s => ({ ...s, newParams: { ...s.newParams, authParams: { ...s.newParams.authParams, secret: v } } }));
    const modifyMetadata: Dispatch<UpdateKeyValueList> = (action: UpdateKeyValueList) => setPageState(s => ({ ...s, newParams: { ...s.newParams, metadata: action(s.newParams.metadata) } }));

    // Update the page state with the connection params
    React.useEffect(() => {
        if (connectionState?.details.type != TRINO_CONNECTOR) {
            return;
        }
        // Did the channel params change?
        // Then we reset the params of the settings page
        const activeParams = connectionState.details.value.channelParams;
        if (activeParams != null && activeParams !== pageState.activeParams) {
            setPageState({
                activeParams: activeParams,
                newParams: activeParams
            });
        }
    }, [connectionState?.details]);

    // Helper to setup the connection
    const setupAbortController = React.useRef<AbortController | null>(null);
    const setupConnection = async () => {
        // Is there a Trino client?
        if (trinoSetup == null) {
            logger.error("Trino connector is unavailable", {}, LOG_CTX);
            return;
        }
        // Is there a connection id?
        if (connectionId == null) {
            logger.warn("Trino connection id is null", {}, LOG_CTX);
            return;
        }

        try {
            // Setup the Trino connection
            setupAbortController.current = new AbortController();
            const connectionParams: TrinoConnectionParams = pageState.newParams;
            const _channel = await trinoSetup.setup(dispatchConnectionState, connectionParams, setupAbortController.current.signal);

            // Start the catalog update
            loadCatalog(connectionId);

        } catch (error: any) {
            // XXX
        }
        setupAbortController.current = null;
    };

    // Helper to cancel and reset the authorization
    const cancelSetup = () => {
        if (setupAbortController.current) {
            setupAbortController.current.abort("abort the Hyper setup");
            setupAbortController.current = null;
        }
    };
    const resetSetup = async () => {
        if (trinoSetup) {
            await trinoSetup.reset(dispatchConnectionState);
        }
    };

    // Helper to switch to the editor
    const selectCurrentWorkbook = useCurrentWorkbookSelector();
    const navigate = useNavigate()
    const switchToEditor = React.useCallback(() => {
        if (workbookId != null) {
            selectCurrentWorkbook(workbookId);
            navigate("/editor");
        }
    }, [workbookId]);

    // Get the connection status
    const statusText: string = getConnectionStatusText(connectionState?.connectionStatus, logger);
    // Get the connection error (if any)
    const connectionError: DetailedError | null = getConnectionError(connectionState?.details ?? null);
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
            connectButton = <Button variant={ButtonVariant.Danger} leadingVisual={XIcon} onClick={cancelSetup}>Cancel</Button>;
            freezeInput = true;
            break;
        case ConnectionHealth.ONLINE:
            connectButton = <Button variant={ButtonVariant.Danger} leadingVisual={XIcon} onClick={resetSetup}>Disconnect</Button>;
            freezeInput = true;
            break;
    }

    // Maintain the workbook setup url for the same platform
    const platformType = usePlatformType();
    const setupLinkTarget = platformType === PlatformType.WEB ? WorkbookLinkTarget.WEB : WorkbookLinkTarget.NATIVE;
    const setupURL = React.useMemo(() => {
        if (workbook == null || connectionState == null || connectionState.details.type != TRINO_CONNECTOR) {
            return null;
        }
        const params: ConnectionParamsVariant = {
            type: TRINO_CONNECTOR,
            value: pageState.newParams
        };
        return generateWorkbookUrl(workbook, params, setupLinkTarget);
    }, [workbook, connectionState, setupLinkTarget]);

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
                    <CopyToClipboardButton
                        variant={ButtonVariant.Default}
                        size={ButtonSize.Medium}
                        logContext={LOG_CTX}
                        value={setupURL?.toString() ?? ""}
                        disabled={setupURL == null}
                        icon={LinkIcon}
                        aria-label="copy-link"
                        aria-labelledby=""
                    />

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
                            {connectionError?.message &&
                                <ErrorDetailsButton className={style.status_error} error={connectionError} />
                            }
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
                            value={pageState.newParams.channelArgs.endpoint}
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
                            value={pageState.newParams.authParams.username}
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
                            value={pageState.newParams.authParams.secret}
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
                            elements={pageState.newParams.metadata}
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
        activeParams: null,
        newParams: {
            channelArgs: {
                endpoint: "http://localhost:8080",
            },
            authParams: {
                username: "",
                secret: "",
            },
            metadata: [],
        }
    });
    return (
        <PAGE_STATE_CTX.Provider value={state}>
            {props.children}
        </PAGE_STATE_CTX.Provider>
    );
};
