import React from 'react';

import { IconButton } from '@primer/react';
import { InfoIcon } from '@primer/octicons-react';

import symbols from '../../../static/svg/symbols.generated.svg';
import pageStyle from '../pages/connections_page.module.css';

interface HyperGrpcConnectorPanelProps {}

export const HyperGrpcConnectorPanel: React.FC<HyperGrpcConnectorPanelProps> = (
    props: HyperGrpcConnectorPanelProps,
) => {
    return (
        <>
            <div className={pageStyle.card_header_container}>
                <div className={pageStyle.platform_logo}>
                    <svg width="28px" height="28px">
                        <use xlinkHref={`${symbols}#hyper`} />
                    </svg>
                </div>
                <div className={pageStyle.platform_name}>Hyper Database</div>
                <div className={pageStyle.platform_info}>
                    <IconButton variant="invisible" icon={InfoIcon} aria-labelledby="info" />
                </div>
            </div>
            <div className={pageStyle.card_body_container}></div>
        </>
    );
};
