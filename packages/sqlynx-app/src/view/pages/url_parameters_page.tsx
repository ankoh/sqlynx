import * as React from 'react';
import { Button, ButtonGroup, IconButton } from '@primer/react';
import { TriangleDownIcon } from '@primer/octicons-react';

import styles from './url_parameters_page.module.css';
import primerBugFixes from '../../primer_bugfixes.module.css';

import symbols from '../../../static/svg/symbols.generated.svg';
import classNames from 'classnames';

interface Props {}

export const URLParametersPage: React.FC<Props> = (props: Props) => {
    const TEST_URL = new URL('https://sqlynx.app?main-script=foo&schema-script=bar&connector-type=sfdc');
    const searchParams = new URLSearchParams(TEST_URL.search);
    const mainScript = searchParams.get('main-script') ?? null;
    const schemaScript = searchParams.get('schema-script') ?? null;
    const connectorType = searchParams.get('connector-type') ?? null;
    // const connectorParams = searchParams.get('connector-params') ?? null;

    const UrlDetailEntry = (props: { label: string; value: string | null }) => (
        <>
            <div className={styles.url_detail_entry_key}>{props.label}</div>
            <div className={styles.url_detail_entry_value}>{props.value}</div>
        </>
    );

    return (
        <div className={styles.page}>
            <div className={styles.center_container}>
                <div className={styles.banner_container}>
                    <div className={styles.banner_logo}>
                        <svg width="80px" height="80px">
                            <use xlinkHref={`${symbols}#sqlynx`} />
                        </svg>
                    </div>
                </div>
                <div className={styles.card_container}>
                    <div className={styles.card_header}>
                        <div className={styles.link_icon}></div>
                        <div className={styles.card_title}>SQLynx Parameters</div>
                    </div>
                    <div className={styles.url_info}>
                        <div className={styles.url_box}>Some URL</div>
                        <div className={styles.url_details}>
                            <UrlDetailEntry label="Main Script" value={mainScript ?? ''} />
                            <UrlDetailEntry label="Schema Script" value={schemaScript ?? ''} />
                            <UrlDetailEntry label="Connector" value={connectorType ?? ''} />
                        </div>
                    </div>
                    <div className={styles.context_content}>
                        <div className={styles.context_content_tabs}>Tabs</div>
                        <div className={styles.context_content_body}>Body</div>
                    </div>
                    <div className={styles.launch_section}>
                        <ButtonGroup className={classNames(primerBugFixes.button_group, styles.launch_button)}>
                            <Button variant="primary">Continue</Button>
                            <IconButton variant="primary" icon={TriangleDownIcon} aria-labelledby="more-actions" />
                        </ButtonGroup>
                    </div>
                </div>
            </div>
        </div>
    );
};
