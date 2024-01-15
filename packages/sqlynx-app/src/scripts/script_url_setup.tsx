import * as React from 'react';

import { Button, IconButton } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { useLocation } from 'react-router-dom';

import {
    CONNECTOR_INFOS,
    ConnectorAuthCheck,
    ConnectorType,
    HYPER_DATABASE,
    LOCAL_SCRIPT,
    SALESFORCE_DATA_CLOUD,
} from '../connectors/connector_info';
import { useSalesforceAuthState } from '../connectors/salesforce_auth_state';
import { checkSalesforceAuthSetup, readConnectorParamsFromURL } from '../connectors/connector_url_params';
import { useSQLynx, useSQLynxLoadingProgress } from '../sqlynx_loader';
import { RESULT_OK, formatBytes, formatNanoseconds } from '../utils';

import styles from './script_url_setup.module.css';

import symbols from '../../static/svg/symbols.generated.svg';

interface Props {
    params: URLSearchParams;
    onDone: () => void;
}

const ScriptURLSetupPage: React.FC<Props> = (props: Props) => {
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
    const connectorParams = readConnectorParamsFromURL(props.params);
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
    const canContinue = connectorAuthCheck === null || connectorAuthCheck === ConnectorAuthCheck.AUTHENTICATED;
    let statusText: string = 'ready';
    switch (connectorAuthCheck) {
        case ConnectorAuthCheck.AUTHENTICATED:
            statusText = 'Authenticated';
            break;
        case ConnectorAuthCheck.AUTHENTICATION_IN_PROGRESS:
            statusText = 'Authentication In Progress';
            break;
        case ConnectorAuthCheck.AUTHENTICATION_NOT_STARTED:
        case ConnectorAuthCheck.CLIENT_ID_MISMATCH:
            statusText = 'Authentication Required';
            break;
        case ConnectorAuthCheck.AUTHENTICATION_FAILED:
            statusText = 'Authentication Failed';
            break;
        case ConnectorAuthCheck.UNKNOWN:
            statusText = '';
            break;
    }

    const DetailEntry = (props: { label: string; children: React.ReactElement }) => (
        <>
            <div className={styles.detail_entry_key}>{props.label}</div>
            <div className={styles.detail_entry_value}>{props.children}</div>
        </>
    );
    const Bean = (props: { text: string }) => <span className={styles.bean}>{props.text}</span>;

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
                    <div className={styles.card_section_header}>SQL</div>
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
                                <DetailEntry label="Instance Url">
                                    <Bean text={connectorParams.value.instanceUrl ?? 'unknown'} />
                                </DetailEntry>
                                <DetailEntry label="Connected App">
                                    <Bean text={connectorParams.value.appConsumerKey ?? 'unknown'} />
                                </DetailEntry>
                            </>
                        )}
                    </div>
                </div>
                <div className={styles.card_actions}>
                    {canContinue ? (
                        <Button className={styles.card_action_continue} variant="primary" onClick={props.onDone}>
                            Continue
                        </Button>
                    ) : (
                        <>
                            <Button className={styles.skip_button} variant="danger" onClick={props.onDone}>
                                Skip
                            </Button>
                            <div className={styles.card_status_text}>{statusText}</div>
                            <IconButton className={styles.card_action_restart} icon={SyncIcon} aria-labelledby="sync" />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

enum SetupVisibility {
    UNDECIDED,
    SKIP,
    SHOW,
}

export const ScriptURLSetup: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
    const [showSetup, setShowSetup] = React.useState<SetupVisibility>(SetupVisibility.UNDECIDED);
    const location = useLocation();
    const params = React.useMemo(() => new URLSearchParams(location.search), []);
    React.useEffect(() => {
        if (!params.has('connector')) {
            setShowSetup(SetupVisibility.SKIP);
        } else {
            setShowSetup(SetupVisibility.SHOW);
        }
    }, []);
    switch (showSetup) {
        case SetupVisibility.UNDECIDED:
            return <div />;
        case SetupVisibility.SKIP:
            return props.children;
        case SetupVisibility.SHOW:
            return <ScriptURLSetupPage params={params} onDone={() => setShowSetup(SetupVisibility.SKIP)} />;
    }
};

// Pack a test url
// const params = new URLSearchParams();
// params.set('connector', 'salesforce');
// params.set('instance', 'https://trialorgfarmforu-16f.test2.my.pc-rnd.salesforce.com');
// params.set('app', '3MVG9GS4BiwvuHvgBoJxvy6gBq99_Ptg8FHx1QqO0bcDgy3lYc3x1b3nLPXGDQzYlYYMOwqo_j12QdTgAvAZD');
// const test_url = new URL(`https://sqlynx.app?${params.toString()}`);
// http://localhost:9002/?connector=salesforce&instance=https%3A%2F%2Ftrialorgfarmforu-16f.test2.my.pc-rnd.salesforce.com&app=3MVG9GS4BiwvuHvgBoJxvy6gBq99_Ptg8FHx1QqO0bcDgy3lYc3x1b3nLPXGDQzYlYYMOwqo_j12QdTgAvAZD
