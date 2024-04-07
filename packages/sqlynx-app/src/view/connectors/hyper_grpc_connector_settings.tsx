import * as React from 'react';
import * as proto from "@ankoh/sqlynx-pb";

import { Button } from '@primer/react';
import { ChecklistIcon, DatabaseIcon, FileBadgeIcon, KeyIcon, PlugIcon, TagIcon } from '@primer/octicons-react';

import { TextField, KeyValueTextField } from '../text_field.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useHyperDatabaseClient } from '../../platform/hyperdb_client_provider.js';

import { KeyValueListBuilder } from '../../view/keyvalue_list.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';

import style from './connector_settings.module.css';

interface Props { }

export const HyperGrpcConnectorSettings: React.FC<Props> = (
    _props: Props,
) => {
    const logger = useLogger();
    const hyperClient = useHyperDatabaseClient();

    const [endpoint, setEndpoint] = React.useState<string>("http://127.0.0.1:9090");
    const [mtlsKeyPath, setMtlsKeyPath] = React.useState<string>("");
    const [mtlsPubPath, setMtlsPubPath] = React.useState<string>("");
    const [mtlsCaPath, setMtlsCaPath] = React.useState<string>("");

    const testSettings = async () => {
        if (hyperClient == null) {
            logger.error("Hyper client is unavailable", "hyper_grpc");
            return;
        }
        try {
            logger.trace(`connecting to endpoint: ${endpoint}`, "hyper_grpc");
            const channel = await hyperClient.connect({
                endpoint
            });

            await channel.executeQuery(new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
                query: "select 1"

            }))

            await channel.close();
        } catch (e: any) {
            console.error(e);
            logger.trace(`connecting failed with error: ${e.toString()}`, "hyper_grpc");
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
            <div className={style.body_container}>
                <div className={style.section_status}>
                    <div className={style.status_bar}>
                        <div className={style.status_indicator} />
                        <div className={style.status_text}>
                            disconnected
                        </div>
                        <div className={style.status_stats}>
                        </div>
                    </div>
                </div>
                <div className={style.section}>
                    <div className={style.section_layout}>
                        <TextField
                            name="gRPC Endpoint"
                            caption="Endpoint of the gRPC service as 'https://host:port'"
                            value={endpoint}
                            placeholder="gRPC endpoint url"
                            leadingVisual={() => <div>URL</div>}
                            onChange={(e) => setEndpoint(e.target.value)}
                            disabled={false}
                        />
                        <KeyValueTextField
                            className={style.grid_column_1}
                            name="mTLS Client Key"
                            caption="Paths to client key and client certificate"
                            k={mtlsKeyPath}
                            v={mtlsPubPath}
                            keyPlaceholder="client.key"
                            valuePlaceholder="client.pem"
                            keyIcon={KeyIcon}
                            valueIcon={FileBadgeIcon}
                            onChangeKey={(e) => setMtlsKeyPath(e.target.value)}
                            onChangeValue={(e) => setMtlsPubPath(e.target.value)}
                            disabled={false}
                        />
                        <TextField
                            name="mTLS CA certificates"
                            caption="Path to certificate authority (CA) certificates"
                            value={mtlsCaPath}
                            placeholder="cacerts.pem"
                            leadingVisual={ChecklistIcon}
                            onChange={(e) => setMtlsCaPath(e.target.value)}
                            disabled={false}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={style.section_layout}>
                        <TextField
                            name="Client ID"
                            caption="All requests are sent with the header 'x-trace-id: sqlynx/<client-id>/hyper/<request-id>'"
                            value=""
                            placeholder="client id"
                            leadingVisual={TagIcon}
                            readOnly
                            disabled
                        />
                        <KeyValueListBuilder
                            className={style.grid_column_1}
                            title="Attached Databases"
                            caption="Databases that are attached for every query"
                            keyIcon={DatabaseIcon}
                            valueIcon={() => <div>ID</div>}
                            addButtonLabel="Add Database"
                        />
                        <KeyValueListBuilder
                            title="gRPC Metadata"
                            caption="Extra HTTP headers that are added to each request"
                            keyIcon={() => <div>Header</div>}
                            valueIcon={() => <div>Value</div>}
                            addButtonLabel="Add Header"
                        />
                    </div>
                </div>
            </div>
        </ div>
    );
};
