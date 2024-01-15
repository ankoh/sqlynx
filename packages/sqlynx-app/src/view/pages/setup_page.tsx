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

    // Unpack the URL parameters
    const TEST_URL = new URL('https://sqlynx.app?script=foo&schema=bar&connector=sfdc');
    const connectorSetup = readConnectorParamsFromURL(TEST_URL);
    let connectorInfo = null;
    let connectorAuthState = null;
    let connectorAuthCheck = null;
    switch (connectorSetup?.type) {
        case SALESFORCE_DATA_CLOUD:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD as number];
            connectorAuthState = salesforceAuth;
            connectorAuthCheck = checkSalesforceAuthSetup(salesforceAuth, connectorSetup.value);
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
                            <Bean text={moduleVersion ?? 'unknown'} />
                        </DetailEntry>
                    </div>
                </div>
                <div className={styles.script_setup}>
                    <div className={styles.card_section_header}>Script</div>
                    <div className={styles.script_details}>
                        <DetailEntry label="Inline Script">
                            <Bean text="3 kB | syntax ok" />
                        </DetailEntry>
                        <DetailEntry label="Inline Schema">
                            <Bean text="10 kB | syntax ok" />
                        </DetailEntry>
                    </div>
                </div>
                <div className={styles.connector_setup}>
                    <div className={styles.card_section_header}>Connector</div>
                    <div className={styles.connector_details}>
                        <DetailEntry label="Connector Type">
                            <Bean text={connectorInfo?.displayName.long ?? 'unknown'} />
                        </DetailEntry>
                        {connectorSetup?.type == SALESFORCE_DATA_CLOUD && (
                            <>
                                <DetailEntry label="Client ID">
                                    <Bean text={connectorAuthState?.authParams?.clientId ?? 'unknown'} />
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
