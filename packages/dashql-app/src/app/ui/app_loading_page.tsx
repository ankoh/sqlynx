import * as React from 'react';

import * as baseStyles from '../../ui/banner/banner_page.module.css';
import * as pageStyles from './app_loading_page.module.css';

import { AppLoadingStatus } from '../router/app_loading_status.js';
import { Button, ButtonVariant } from '../../ui/foundations/button.js';
import { CONFIRM_FINISHED_SETUP, useRouteContext, useRouterNavigate } from '../router/router.js';
import { getStatusFromProgressCounter, IndicatorStatus, StatusIndicator } from '../../ui/foundations/status_indicator.js';
import { useDashQLCoreSetup } from '../providers/core_provider.js';
import { AppLoadingProgress } from '../loading/app_loading_progress.js';
import { ParticleFlowBackground } from '../../ui/particle_flow/particle_flow_background.js';
import { CompactNavBar } from './navbar.js';

interface Props {
    pauseAfterSetup: boolean;
    progress: AppLoadingProgress;
    embeddedDatabaseStatus: IndicatorStatus;
}


export const AppLoadingPage: React.FC<Props> = (props: Props) => {
    const navigate = useRouterNavigate();
    const coreSetup = useDashQLCoreSetup();
    const routeContext = useRouteContext();

    // Subscribe core setup.
    // Core setup does not have to run to completion, we're skipping past the loader before the wasm setup is done.
    const [coreStatus, setCoreStatus] = React.useState<IndicatorStatus>(IndicatorStatus.None);
    React.useEffect(() => {
        const abort = new AbortController();
        const run = async () => {
            try {
                setCoreStatus(IndicatorStatus.Running);
                await coreSetup("app_loader");
                if (!abort.signal.aborted) {
                    setCoreStatus(IndicatorStatus.Succeeded);
                }
            } catch (e: any) {
                setCoreStatus(IndicatorStatus.Failed);
            }
        };
        run();
        return () => abort.abort();
    }, []);

    // Show the continue button?
    const showContinueButton = props.pauseAfterSetup && routeContext.appLoadingStatus == AppLoadingStatus.SETUP_DONE;
    const confirmFinishedSetup = React.useCallback(() => {
        navigate({
            type: CONFIRM_FINISHED_SETUP,
            value: true
        });
    }, [navigate]);

    return (
        <div className={`${baseStyles.page} ${pageStyles.page}`} data-electron-drag-region>
            <ParticleFlowBackground />
            <CompactNavBar />
            <div className={`${baseStyles.banner_and_content_container} ${pageStyles.foreground}`} data-electron-drag-region>
                <div className={baseStyles.content_container} data-electron-drag-region>
                    <div className={baseStyles.card}>
                        <div className={baseStyles.card_header} data-electron-drag-region>
                            <div className={baseStyles.card_header_left_container}>
                                <div className={baseStyles.card_header_left_title}>
                                    Setup
                                </div>
                            </div>
                        </div>
                        <div className={baseStyles.card_section}>
                            <div className={baseStyles.section_entries}>
                                <div className={pageStyles.detail_entries}>
                                    <div className={pageStyles.detail_entry_key}>
                                        Initialize Core
                                    </div>
                                    <div className={pageStyles.detail_entry_value}>
                                        <StatusIndicator
                                            className={pageStyles.loading_status_indicator}
                                            fill="black"
                                            width={"14px"}
                                            height={"14px"}
                                            status={coreStatus}
                                        />
                                    </div>
                                    <div className={pageStyles.detail_entry_key}>
                                        Initialize HyperDB
                                    </div>
                                    <div className={pageStyles.detail_entry_value}>
                                        <StatusIndicator
                                            className={pageStyles.loading_status_indicator}
                                            fill="black"
                                            width={"14px"}
                                            height={"14px"}
                                            status={props.embeddedDatabaseStatus}
                                        />
                                    </div>
                                    <div className={pageStyles.detail_entry_key}>
                                        Discover Sessions
                                    </div>
                                    <div className={pageStyles.detail_entry_value}>
                                        <StatusIndicator
                                            className={pageStyles.loading_status_indicator}
                                            fill="black"
                                            width={"14px"}
                                            height={"14px"}
                                            status={getStatusFromProgressCounter(props.progress.restoreConnections)}
                                        />
                                    </div>
                                    <div className={pageStyles.detail_entry_key}>
                                        Load Session Scripts
                                    </div>
                                    <div className={pageStyles.detail_entry_value}>
                                        <StatusIndicator
                                            className={pageStyles.loading_status_indicator}
                                            fill="black"
                                            width={"14px"}
                                            height={"14px"}
                                            status={getStatusFromProgressCounter(props.progress.restoreSessionScripts)}
                                        />
                                    </div>
                                </div>
                            </div>
                            {props.pauseAfterSetup && (
                                <div className={baseStyles.card_actions}>
                                    <div className={baseStyles.card_actions_right}>
                                        <Button
                                            variant={ButtonVariant.Primary}
                                            disabled={!showContinueButton}
                                            onClick={confirmFinishedSetup}
                                        >
                                            Continue
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
