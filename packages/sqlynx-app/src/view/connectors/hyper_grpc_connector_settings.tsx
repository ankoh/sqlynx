import * as React from 'react';
import { TextInput, FormControl, Button } from '@primer/react';
import { CopyIcon, DatabaseIcon, MentionIcon, XIcon } from '@primer/octicons-react';

import { useAppConfig } from '../../app_config.js';
import { KeyValueListBuilder } from '../../view/keyvalue_list.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';

import baseStyle from './connector_settings.module.css';
import hyperStyle from './hyper_grpc_connector_settings.module.css';

interface Props { }

interface ListElement {
    name: string;
    alias: string;
}

export const HyperGrpcConnectorSettings: React.FC<Props> = (
    _props: Props,
) => {
    const config = useAppConfig();
    const [selectedProtocol, selectProtocol] = React.useState(1);
    const CopyAction = () => (
        <TextInput.Action
            onClick={() => {
                alert('clear input');
            }}
            icon={CopyIcon}
            aria-label="Clear input"
        />
    );
    const MutableTextBox = (props: {
        name: string;
        caption: string;
        value: string;
        onChange: React.ChangeEventHandler<HTMLInputElement>;
        disabled: boolean;
    }) => (
        <FormControl sx={{ marginTop: '8px' }} disabled={props.disabled}>
            <FormControl.Label>{props.name}</FormControl.Label>
            <TextInput block trailingAction={CopyAction()} value={props.value} onChange={props.onChange} />
            <FormControl.Caption>{props.caption}</FormControl.Caption>
        </FormControl>
    );

    const elements: ListElement[] = [{
        name: "foo",
        alias: ""
    }];

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
                        <MutableTextBox
                            name="gRPC Endpoint"
                            caption="Endpoint of the gRPC service as '<https://host:port>'"
                            value="https://127.0.0.1:8443"
                            onChange={() => { }}
                            disabled={false}
                        />
                        <MutableTextBox
                            name="Client UUID"
                            caption="Requests are sent with the header 'x-trace-id: sqlynx/<client-uuid>/<query-id>'"
                            value="<client uuid>"
                            onChange={() => { }}
                            disabled={false}
                        />
                        <KeyValueListBuilder
                            className={hyperStyle.kvlist}
                            title="Attached Databases"
                            caption="Databases that are attached for every query"
                            keyIcon={() => <div>Header</div>}
                            valueIcon={() => <div>Value</div>}
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
