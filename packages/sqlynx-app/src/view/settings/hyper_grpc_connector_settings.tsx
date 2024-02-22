import * as React from 'react';
import { TextInput, FormControl, Button, IconButton, SegmentedControl } from '@primer/react';
import { CopyIcon, InfoIcon } from '@primer/octicons-react';

import { useAppConfig } from '../../app_config.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';

import baseStyle from './connector_settings.module.css';
import hyperStyle from './hyper_grpc_connector_settings.module.css';

interface Props { }

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
    const grpcConnectorDisabled = !config.value?.features?.grpcConnector;
    return (
        <>
            <div className={baseStyle.connector_header_container}>
                <div className={baseStyle.platform_logo}>
                    <svg width="24px" height="24px">
                        <use xlinkHref={`${symbols}#hyper`} />
                    </svg>
                </div>
                <div className={baseStyle.platform_name} aria-labelledby="connector-hyper-database">
                    Hyper Database
                </div>
                <div className={baseStyle.platform_info}>
                    <IconButton
                        variant="invisible"
                        icon={InfoIcon}
                        aria-labelledby="connector-hyper-database"
                        disabled={grpcConnectorDisabled}
                    />
                </div>
            </div>
            <div className={baseStyle.connector_body_container}>
                <div className={hyperStyle.auth_config_container}>
                    <FormControl sx={{ marginTop: '8px' }} disabled={grpcConnectorDisabled}>
                        <FormControl.Label id="protocol-selector" as="span">
                            Protocol
                        </FormControl.Label>
                        <SegmentedControl
                            aria-labelledby="protocol-selector"
                            onChange={selectProtocol}
                            sx={{ marginTop: '4px', opacity: grpcConnectorDisabled ? 0.75 : 1.0 }}
                        >
                            <SegmentedControl.Button selected={selectedProtocol === 0} disabled={grpcConnectorDisabled}>
                                gRPC
                            </SegmentedControl.Button>
                            <SegmentedControl.Button selected={selectedProtocol === 1} disabled={grpcConnectorDisabled}>
                                Web
                            </SegmentedControl.Button>
                        </SegmentedControl>
                        <FormControl.Caption>
                            {selectedProtocol === 0 ? 'gRPC through Electron' : 'gRPC Web through Browser'}
                        </FormControl.Caption>
                    </FormControl>
                    <div className={hyperStyle.auto_config_protocol_settings}>
                        <MutableTextBox
                            name="Endpoint"
                            caption="Endpoint of the gRPC service as '<https://host:port>'"
                            value="https://127.0.0.1:8443"
                            onChange={() => { }}
                            disabled={grpcConnectorDisabled}
                        />
                        <div className={hyperStyle.auth_config_connect}>
                            <Button sx={{ marginTop: '28px' }} disabled={grpcConnectorDisabled}>
                                Connect
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
};
