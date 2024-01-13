import * as React from 'react';
import { Button, ButtonGroup, IconButton } from '@primer/react';
import { TriangleDownIcon } from '@primer/octicons-react';
import { CONNECTOR_INFOS } from '../../connectors/connector_info';

import styles from './setup_page.module.css';
import primerBugFixes from '../../primer_bugfixes.module.css';

import symbols from '../../../static/svg/symbols.generated.svg';
import classNames from 'classnames';

interface Props {}

export const SetupPage: React.FC<Props> = (props: Props) => {
    const TEST_URL = new URL('https://sqlynx.app?script=foo&schema=bar&connector=sfdc');
    const searchParams = new URLSearchParams(TEST_URL.search);
    const mainScript = searchParams.get('script') ?? null;
    const schemaScript = searchParams.get('schema') ?? null;
    const connectorType = searchParams.get('connector') ?? null;

    let connectorId: number = connectorType == null ? 0 : Number.parseInt(connectorType);
    connectorId = connectorId < CONNECTOR_INFOS.length ? connectorId : 0;
    const connectorInfo = CONNECTOR_INFOS[connectorId];

    const DetailEntry = (props: { label: string; children: React.ReactElement }) => (
        <>
            <div className={styles.url_detail_key}>{props.label}</div>
            <div className={styles.url_detail_value}>{props.children}</div>
        </>
    );
    const Bean = (props: { text: string }) => <div className={styles.bean}>{props.text}</div>;

    return (
        <div className={styles.page}>
            <div className={styles.center_container}>
                <div className={styles.banner_container}>
                    <div className={styles.banner_logo}>
                        <svg width="64px" height="64px">
                            <use xlinkHref={`${symbols}#sqlynx`} />
                        </svg>
                    </div>
                </div>
                <div className={styles.card_container}>
                    <div className={styles.card_header}>
                        <div className={styles.link_icon}></div>
                        <div className={styles.card_title}>Setup</div>
                    </div>
                    <div className={styles.wasm_setup}>
                        <div className={styles.card_section_header}>WebAssembly</div>
                        <div className={styles.wasm_details}>
                            <DetailEntry label="Module Size">
                                <Bean text="102 kB" />
                            </DetailEntry>
                            <DetailEntry label="Instantiation Time">
                                <Bean text="~10 ms" />
                            </DetailEntry>
                            <DetailEntry label="Version">
                                <Bean text="0.0.1-dev1204" />
                            </DetailEntry>
                        </div>
                    </div>
                    <div className={styles.url_setup}>
                        <div className={styles.card_section_header}>URL Parameters</div>
                        <div className={styles.url_details}>
                            <DetailEntry label="Connector Type">
                                <Bean text={connectorInfo.displayName.long} />
                            </DetailEntry>
                            <DetailEntry label="Inline Script">
                                <Bean text="3 kB | 142 symbols" />
                            </DetailEntry>
                            <DetailEntry label="Inline Schema">
                                <Bean text="10 kB | 1.5k symbols" />
                            </DetailEntry>
                        </div>
                    </div>
                    <div className={styles.auth_setup}>
                        <div className={styles.card_section_header}>Authentiation</div>
                    </div>
                    <div className={styles.card_actions}>
                        <Button className={styles.skip_button} variant="danger">
                            Skip
                        </Button>
                        <Button className={styles.continue_button} variant="primary">
                            Continue
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};
