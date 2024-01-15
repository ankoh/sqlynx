import * as React from 'react';

import { Button } from '@primer/react';

import {
    CONNECTOR_INFOS,
    ConnectorAuthCheck,
    ConnectorType,
    HYPER_DATABASE,
    LOCAL_SCRIPT,
    SALESFORCE_DATA_CLOUD,
} from '../../connectors/connector_info';
import { checkSalesforceAuthSetup, useSalesforceAuthState } from '../../connectors/salesforce_auth_state';
import { readConnectorParamsFromURL } from '../../connectors/connector_url_params';
import { useSQLynx, useSQLynxLoadingProgress } from '../../sqlynx_loader';
import { RESULT_OK, formatBytes, formatNanoseconds } from '../../utils';

import styles from './setup_page.module.css';

import symbols from '../../../static/svg/symbols.generated.svg';

interface Props {}

export const SetupPage: React.FC<Props> = (props: Props) => {
    const lnx = useSQLynx();
    const lnxLoading = useSQLynxLoadingProgress();
    const salesforceAuth = useSalesforceAuthState();

    // Get instantiation progress
    let moduleSizeLoaded = BigInt(0);
    let moduleInitTime = 0;
    if (lnxLoading) {
        moduleSizeLoaded = lnxLoading.bytesLoaded;
        moduleInitTime = lnxLoading.updatedAt.getTime() - lnxLoading.startedAt.getTime();
    }
    let moduleVersion: string | null = null;
    if (lnx?.type == RESULT_OK) {
        moduleVersion = lnx.value.getVersionText();
    }

    // Pack a test url
    const params = new URLSearchParams();
    params.set('connector', 'salesforce');
    params.set('instance', 'https://trialorgfarmforu-16f.test2.my.pc-rnd.salesforce.com');
    params.set('app', '3MVG9GS4BiwvuHvgBoJxvy6gBq99_Ptg8FHx1QqO0bcDgy3lYc3x1b3nLPXGDQzYlYYMOwqo_j12QdTgAvAZD');
    const test_url = new URL(`https://sqlynx.app?${params.toString()}`);

    // Unpack the URL parameters
    const connectorParams = readConnectorParamsFromURL(test_url);
    let connectorInfo = null;
    let connectorAuthCheck = null;
    switch (connectorParams?.type) {
        case SALESFORCE_DATA_CLOUD:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD as number];
            connectorAuthCheck = checkSalesforceAuthSetup(salesforceAuth, connectorParams.value);
            break;
        case HYPER_DATABASE:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.HYPER_DATABASE as number];
            break;
        case LOCAL_SCRIPT:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.LOCAL_SCRIPT as number];
            break;
    }

    // Get the auth status
    let authStatus: string = 'not required';
    switch (connectorAuthCheck) {
        case ConnectorAuthCheck.AUTHENTICATED:
            authStatus = 'authenticated';
            break;
        case ConnectorAuthCheck.AUTHENTICATION_IN_PROGRESS:
            authStatus = 'in progress';
            break;
        case ConnectorAuthCheck.AUTHENTICATION_NOT_STARTED:
            authStatus = 'not started';
            break;
        case ConnectorAuthCheck.CLIENT_ID_MISMATCH:
            authStatus = 'id mismatch';
            break;
        case ConnectorAuthCheck.AUTHENTICATION_FAILED:
            authStatus = 'failed';
            break;
        case ConnectorAuthCheck.UNKNOWN:
            authStatus = 'unknown';
            break;
    }

    const DetailEntry = (props: { label: string; children: React.ReactElement }) => (
        <>
            <div className={styles.detail_entry_key}>{props.label}</div>
            <div className={styles.detail_entry_value}>{props.children}</div>
        </>
    );
    const Bean = (props: { text: string }) => <div className={styles.bean}>{props.text}</div>;

    return (
        <div className={styles.page}>
            <div className={styles.banner_container}>
                <div className={styles.banner_logo}>
                    <svg width="100%" height="100%">
                        <use xlinkHref={`${symbols}#sqlynx`} />
                    </svg>
                </div>
                <div className={styles.banner_title}>sqlynx</div>
            </div>
            <div className={styles.card_container}>
                <div className={styles.card_header}>
                    <div className={styles.card_title}>Setup</div>
                </div>
                <div className={styles.card_section}>
                    <div className={styles.card_section_header}>WebAssembly</div>
                    <div className={styles.detail_entries}>
                        <DetailEntry label="Uncompressed Size">
                            <Bean text={formatBytes(Number(moduleSizeLoaded))} />
                        </DetailEntry>
                        <DetailEntry label="Instantiation Time">
                            <Bean text={formatNanoseconds(moduleInitTime * 1000000)} />
                        </DetailEntry>
                        <DetailEntry label="Module Version">
                            <Bean text={moduleVersion ?? 'unknown'} />
                        </DetailEntry>
                    </div>
                </div>
                <div className={styles.card_section}>
                    <div className={styles.card_section_header}>Script</div>
                    <div className={styles.detail_entries}>
                        <DetailEntry label="Inline Script">
                            <Bean text="3 kB | syntax ok" />
                        </DetailEntry>
                        <DetailEntry label="Inline Schema">
                            <Bean text="10 kB | syntax ok" />
                        </DetailEntry>
                    </div>
                </div>
                <div className={styles.card_section}>
                    <div className={styles.card_section_header}>Connector</div>
                    <div className={styles.detail_entries}>
                        <DetailEntry label="Connector Type">
                            <Bean text={connectorInfo?.displayName.long ?? 'unknown'} />
                        </DetailEntry>
                        {connectorParams?.type == SALESFORCE_DATA_CLOUD && (
                            <>
                                <DetailEntry label="Instance URL">
                                    <Bean text={connectorParams.value.instanceUrl ?? 'unknown'} />
                                </DetailEntry>
                                <DetailEntry label="Connected App">
                                    <Bean text={connectorParams.value.appConsumerKey ?? 'unknown'} />
                                </DetailEntry>
                            </>
                        )}
                        <DetailEntry label="Authentication">
                            <Bean text={authStatus} />
                        </DetailEntry>
                    </div>
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
    );
};
