import * as React from 'react';

import { Button } from '@primer/react';

import { CONNECTOR_INFOS } from '../../connectors/connector_info';
import { useSQLynx, useSQLynxLoadingProgress } from '../../sqlynx_loader';
import { RESULT_OK, formatBytes, formatNanoseconds } from '../../utils';

import styles from './setup_page.module.css';

import symbols from '../../../static/svg/symbols.generated.svg';

interface Props {}

export const SetupPage: React.FC<Props> = (props: Props) => {
    const lnxLoaderProgress = useSQLynxLoadingProgress();
    const lnx = useSQLynx();

    // Get instantiation progress
    let moduleSizeLoaded = BigInt(0);
    let moduleInitTime = 0;
    if (lnxLoaderProgress) {
        moduleSizeLoaded = lnxLoaderProgress.bytesLoaded;
        moduleInitTime = lnxLoaderProgress.updatedAt.getTime() - lnxLoaderProgress.startedAt.getTime();
    }

    // Get SQLynx version
    let version: string | null = null;
    if (lnx?.type == RESULT_OK) {
        version = lnx.value.getVersionText();
    }

    const TEST_URL = new URL('https://sqlynx.app?script=foo&schema=bar&connector=sfdc');
    const searchParams = new URLSearchParams(TEST_URL.search);
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
                        <svg width="72px" height="72px">
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
                            <DetailEntry label="Uncompressed Size">
                                <Bean text={formatBytes(Number(moduleSizeLoaded))} />
                            </DetailEntry>
                            <DetailEntry label="Instantiation Time">
                                <Bean text={formatNanoseconds(moduleInitTime * 1000000)} />
                            </DetailEntry>
                            <DetailEntry label="Module Version">
                                <Bean text={version ?? 'unknown'} />
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
