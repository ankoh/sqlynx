import React from 'react';

import { TextInput, FormControl, Button, IconButton, SegmentedControl } from '@primer/react';
import { CopyIcon } from '@primer/octicons-react';

import symbols from '../../../static/svg/symbols.generated.svg';

import pageStyle from '../pages/connections_page.module.css';
import panelStyle from './hyper_grpc_connector_panel.module.css';

interface HyperGrpcConnectorPanelProps {}

export const HyperGrpcConnectorPanel: React.FC<HyperGrpcConnectorPanelProps> = (
    props: HyperGrpcConnectorPanelProps,
) => {
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
    const MutableTextBox = (props: { name: string; caption: string }) => (
        <FormControl sx={{ marginTop: '8px' }}>
            <FormControl.Label>{props.name}</FormControl.Label>
            <TextInput block trailingAction={CopyAction()} />
            <FormControl.Caption>{props.caption}</FormControl.Caption>
        </FormControl>
    );
    return (
        <>
            <div className={pageStyle.card_header_container}>
                <div className={pageStyle.platform_logo}>
                    <svg width="24px" height="24px">
                        <use xlinkHref={`${symbols}#hyper`} />
                    </svg>
                </div>
                <div className={pageStyle.platform_name}>Hyper Database</div>
                <div className={pageStyle.platform_info}>
                    <IconButton variant="invisible" icon={CopyIcon} aria-labelledby="info" />
                </div>
            </div>
            <div className={pageStyle.card_body_container}>
                <div className={panelStyle.auth_config_container}>
                    <FormControl sx={{ marginTop: '8px' }}>
                        <FormControl.Label>Protocol</FormControl.Label>
                        <SegmentedControl
                            aria-labelledby="protocol"
                            onChange={selectProtocol}
                            sx={{ marginTop: '4px' }}
                        >
                            <SegmentedControl.Button selected={selectedProtocol === 0}>gRPC</SegmentedControl.Button>
                            <SegmentedControl.Button selected={selectedProtocol === 1}>
                                gRPC Web
                            </SegmentedControl.Button>
                        </SegmentedControl>
                        <FormControl.Caption>Use gRPC over HTTP 1.1</FormControl.Caption>
                    </FormControl>
                    <div className={panelStyle.auto_config_protocol_settings}>
                        <MutableTextBox name="Endpoint" caption="Endpoint of the gRPC service <host:port>" />
                    </div>
                    <div className={panelStyle.auth_config_connect}>
                        <Button sx={{ marginTop: '28px' }}>Connect</Button>
                    </div>
                </div>
            </div>
        </>
    );
};
