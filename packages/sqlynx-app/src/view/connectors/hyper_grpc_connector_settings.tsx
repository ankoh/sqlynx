import * as React from 'react';
import { Button } from '@primer/react';
import { ChecklistIcon, DatabaseIcon, FileBadgeIcon, KeyIcon, LogIcon, PulseIcon, TagIcon } from '@primer/octicons-react';
import { TextField, KeyValueTextField } from '../text_field.js';

import { KeyValueListBuilder } from '../../view/keyvalue_list.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';

import style from './connector_settings.module.css';

interface Props { }

export const HyperGrpcConnectorSettings: React.FC<Props> = (
    _props: Props,
) => {
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
                    <Button leadingVisual={LogIcon} count={3}>Logs</Button>
                    <Button leadingVisual={PulseIcon}>Test</Button>
                </div>
            </div >
            <div className={style.body_container}>
                <div className={style.section}>
                    <div className={style.section_layout}>
                        <TextField
                            name="gRPC Endpoint"
                            caption="Endpoint of the gRPC service as 'https://host:port'"
                            value="https://127.0.0.1:8443"
                            placeholder="gRPC endpoint url"
                            leadingVisual={() => <div>URL</div>}
                            onChange={() => { }}
                            disabled={false}
                        />
                        <KeyValueTextField
                            className={style.grid_column_1}
                            name="mTLS Client Key"
                            caption="Paths to client key and client certificate"
                            k=""
                            v=""
                            keyPlaceholder="client.key"
                            valuePlaceholder="client.pem"
                            keyIcon={KeyIcon}
                            valueIcon={FileBadgeIcon}
                            onChange={() => { }}
                            disabled={false}
                        />
                        <TextField
                            name="mTLS CA certificates"
                            caption="Path to certificate authority (CA) certificates"
                            value=""
                            placeholder="cacerts.pem"
                            leadingVisual={ChecklistIcon}
                            onChange={() => { }}
                            disabled={false}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={style.section_layout}>
                        <TextField
                            name="Client ID"
                            caption="All requests are sent with the header 'x-trace-id: <client-id>/hyper/<request-id>'"
                            value=""
                            placeholder="client id"
                            leadingVisual={TagIcon}
                            onChange={() => { }}
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
