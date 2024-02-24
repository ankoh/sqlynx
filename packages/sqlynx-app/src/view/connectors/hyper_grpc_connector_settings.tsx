import * as React from 'react';
import { ChecklistIcon, DatabaseIcon, KeyIcon, LinkIcon, ListOrderedIcon, ShieldCheckIcon, ShieldLockIcon, VerifiedIcon } from '@primer/octicons-react';
import { TextField, KeyValueTextField } from '../text_field.js';

import { KeyValueListBuilder } from '../../view/keyvalue_list.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';

import baseStyle from './connector_settings.module.css';
import hyperStyle from './hyper_grpc_connector_settings.module.css';

interface Props { }

export const HyperGrpcConnectorSettings: React.FC<Props> = (
    _props: Props,
) => {
    return (
        <>
            <div className={baseStyle.connector_header_container}>
                <div className={baseStyle.platform_logo}>
                    <svg width="28px" height="28px">
                        <use xlinkHref={`${symbols}#hyper`} />
                    </svg>
                </div>
                <div className={baseStyle.platform_name} aria-labelledby="connector-hyper-database">
                    Hyper Database
                </div>
            </div>
            <div className={hyperStyle.body_container}>
                <div className={hyperStyle.section}>
                    <div className={hyperStyle.section_layout}>
                        <TextField
                            name="gRPC Endpoint"
                            caption="Endpoint of the gRPC service as '<https://host:port>'"
                            value="https://127.0.0.1:8443"
                            onChange={() => { }}
                            disabled={false}
                        />
                        <TextField
                            name="Client ID"
                            caption="Requests are sent with the header 'x-trace-id: <client-id>'"
                            value="<client id>"
                            onChange={() => { }}
                        />
                        <KeyValueTextField
                            name="mTLS Server Certificate"
                            caption="Path to the server certificate and CA chain"
                            k=""
                            v=""
                            keyIcon={VerifiedIcon}
                            valueIcon={ChecklistIcon}
                            onChange={() => { }}
                            disabled={false}
                        />
                        <TextField
                            name="mTLS Client Key"
                            caption="Path to the private key of the client"
                            value=""
                            leadingVisual={KeyIcon}
                            onChange={() => { }}
                            disabled={false}
                        />
                        <KeyValueListBuilder
                            className={hyperStyle.kvlist}
                            title="Attached Databases"
                            caption="Databases that are attached for every query"
                            keyIcon={DatabaseIcon}
                            valueIcon={() => <div>ID</div>}
                            addButtonLabel="Add Database"
                        />
                        <KeyValueListBuilder
                            className={hyperStyle.kvlist}
                            title="gRPC Metadata"
                            caption="Extra HTTP headers that are added to each request"
                            keyIcon={() => <div>Header</div>}
                            valueIcon={() => <div>Value</div>}
                            addButtonLabel="Add Header"
                        />
                    </div>
                </div>
            </div>
        </>
    );
};
