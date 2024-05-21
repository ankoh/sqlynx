import * as React from 'react';
import * as proto from "@ankoh/sqlynx-pb";
import * as Immutable from 'immutable';

import { Button } from '@primer/react';
import { ChecklistIcon, DatabaseIcon, FileBadgeIcon, KeyIcon, PlugIcon } from '@primer/octicons-react';

import { classNames } from '../../utils/classnames.js';
import { TextField, KeyValueTextField } from '../text_field.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useHyperDatabaseClient } from '../../platform/hyperdb_client_provider.js';
import { KeyValueListBuilder, KeyValueListElement, UpdateKeyValueList } from '../../view/keyvalue_list.js';
import { IndicatorStatus, StatusIndicator } from '../../view/status_indicator.js';
import { Dispatch } from '../../utils/variant.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connector_settings.module.css';

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

export const HyperGrpcConnectorSettings: React.FC<{}> = (_props: {}) => {
    const logger = useLogger();
    const hyperClient = useHyperDatabaseClient();

    // Resolve Hyper connection state
    // const connectionId = useSalesforceConnectionId();
    // const [connectionState, setConnectionState] = useConnectionState(connectionId);
    // const salesforceConnection = asSalesforceConnection(connectionState);
    // const salesforceAuthFlow = useSalesforceAuthFlow();

    // Wire up the page state
    const [pageState, setPageState] = React.useContext(PAGE_STATE_CTX)!;
    const setEndpoint = (v: string) => setPageState(s => ({ ...s, endpoint: v }));
    const setMtlsKeyPath = (v: string) => setPageState(s => ({ ...s, mTlsKeyPath: v }));
    const setMtlsPubPath = (v: string) => setPageState(s => ({ ...s, mTlsPubPath: v }));
    const setMtlsCaPath = (v: string) => setPageState(s => ({ ...s, mTlsCaPath: v }));
    const modifyAttachedDbs: Dispatch<UpdateKeyValueList> = (action: UpdateKeyValueList) => setPageState(s => ({ ...s, attachedDatabases: action(s.attachedDatabases) }));
    const modifyGrpcMetadata: Dispatch<UpdateKeyValueList> = (action: UpdateKeyValueList) => setPageState(s => ({ ...s, gRPCMetadata: action(s.gRPCMetadata) }));

    const testSettings = async () => {
        if (hyperClient == null) {
            logger.error("Hyper client is unavailable", LOG_CTX);
            return;
        }
        try {
            logger.trace(`connecting to endpoint: ${pageState.endpoint}`, LOG_CTX);
            const channel = await hyperClient.connect({
                endpoint: pageState.endpoint
            });

            await channel.executeQuery(new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
                query: "select 1"

            }))

            await channel.close();
        } catch (e: any) {
            console.error(e);
            logger.trace(`connecting failed with error: ${e.toString()}`, LOG_CTX);
        }
    };

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
                        variant='primary'
                        leadingVisual={PlugIcon}
                        onClick={testSettings}
                    >Connect</Button>
                </div>
            </div >
            <div className={style.status_container}>
                <div className={classNames(style.section, style.status_section)}>
                    <div className={classNames(style.section_layout, style.status_section_layout)}>
                        <div className={style.status_bar}>
                            <div className={style.status_indicator}>
                                <StatusIndicator className={style.status_indicator_spinner} status={IndicatorStatus.Running} fill="black" />
                            </div>
                            <div className={style.status_text}>
                                disconnected
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
                            onChangeKey={(e) => setMtlsKeyPath(e.target.value)}
                            onChangeValue={(e) => setMtlsPubPath(e.target.value)}
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
                            onChange={(e) => setMtlsCaPath(e.target.value)}
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
