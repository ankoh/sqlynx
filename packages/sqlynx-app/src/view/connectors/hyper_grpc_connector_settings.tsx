import * as React from 'react';
import { TextInput, FormControl, Button } from '@primer/react';
import { CopyIcon, DatabaseIcon, MentionIcon, XIcon } from '@primer/octicons-react';

import { useAppConfig } from '../../app_config.js';

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
                    <div className={hyperStyle.centered_section}>
                        <MutableTextBox
                            name="gRPC Endpoint"
                            caption="Endpoint of the gRPC service as '<https://host:port>'"
                            value="https://127.0.0.1:8443"
                            onChange={() => { }}
                            disabled={false}
                        />
                        <div className={hyperStyle.attached_db_list}>
                            <div className={hyperStyle.attached_db_list_name}>
                                Attached Databases
                            </div>
                            <div className={hyperStyle.attached_db_caption}>
                                Databases that are attached for each query
                            </div>
                            <div className={hyperStyle.attached_db_list_elements}>
                                {elements.map((props, i) => (
                                    <div key={i} className={hyperStyle.attached_db_element}>
                                        <TextInput
                                            block
                                            className={hyperStyle.attached_db_path}
                                            value={props.name}
                                            onChange={() => { }}
                                            leadingVisual={DatabaseIcon}
                                            trailingAction={
                                                <TextInput.Action
                                                    onClick={() => {
                                                        alert('clear input')
                                                    }}
                                                    icon={XIcon}
                                                    sx={{ color: 'fg.subtle' }}
                                                    aria-label="Clear input"
                                                />
                                            }
                                        />
                                        <div className={hyperStyle.attached_db_aliaslink} />
                                        <TextInput
                                            block
                                            className={hyperStyle.attached_db_alias}
                                            value={props.alias}
                                            onChange={() => { }}
                                            placeholder="Database Alias"
                                            leadingVisual={MentionIcon}
                                            trailingAction={CopyAction()}
                                        />
                                    </div>))}
                            </div>
                            <Button
                                className={hyperStyle.attach_db_button}
                            >Add Database</Button>
                        </div>
                        <MutableTextBox
                            name="Tracing Data"
                            caption="Queries are sent with header 'x-trace-id: sqlynx/<value>/<query-id>'"
                            value="<random uuid>"
                            onChange={() => { }}
                            disabled={false}
                        />
                    </div>
                </div>
            </div>
        </>
    );
};
