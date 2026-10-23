import * as React from 'react';

import * as baseStyles from '../../ui/banner/banner_page.module.css';
import * as styles from './app_ownership_gate.module.css';

import { AppOwnership, AppOwnershipTimeoutError, getAppOwnershipEnvironment, type AppOwnershipEnvironment } from '../../platform/crosstab/app_ownership.js';
import { APP_HAND_OVER_CTX, type AppHandOverHook } from '../../platform/crosstab/app_hand_over.js';
import { Button, ButtonVariant } from '../../ui/foundations/button.js';
import { ParticleFlowBackground } from '../../ui/particle_flow/particle_flow_background.js';
import { CompactNavBar } from '../ui/navbar.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { stringifyError } from '../../platform/logger/logger.js';

const LOG_CTX = 'app_ownership';

/// How long a tab waits for the owner to hand over the app
const TAKE_OVER_TIMEOUT_MS = 10_000;
/// How long the owner waits for its writers to stop before it hands over anyway
const HAND_OVER_TIMEOUT_MS = 5_000;

enum GateStatus {
    /// Waiting for the lock
    ACQUIRING,
    /// The tab owns the app
    OWNER,
    /// The tab stops its writers for another tab
    HANDING_OVER,
    /// Another tab owns the app
    ELSEWHERE,
    /// The tab asked the owner for the app
    TAKING_OVER,
    /// The owner did not hand over the app
    UNRESPONSIVE,
}

/// Leave the app after handing it over. The reload stops everything the tab still runs, and the
/// browser releases the lock when the page unloads. The tab then boots into the "open elsewhere" page.
function reloadTab(): Promise<void> {
    window.location.reload();
    return new Promise(() => { });
}

interface Props {
    children: React.ReactElement;
    /// The tabs of the app, defaults to the Web Locks and broadcast channels of the browser
    environment?: AppOwnershipEnvironment | null;
    /// Leave the app after the writers stopped, defaults to a reload of the tab
    leave?: () => Promise<void>;
}

/// Render the app only in the tab that owns it, see `AppOwnership`
export const AppOwnershipGate: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const environment = React.useMemo(() => props.environment !== undefined ? props.environment : getAppOwnershipEnvironment(), [props.environment]);
    const [status, setStatus] = React.useState<GateStatus>(environment == null ? GateStatus.OWNER : GateStatus.ACQUIRING);
    const ownership = React.useRef<AppOwnership | null>(null);

    // The hooks of the writers that are stopped before a handoff
    const hooks = React.useRef(new Set<AppHandOverHook>());
    const register = React.useCallback((hook: AppHandOverHook) => {
        hooks.current.add(hook);
        return () => { hooks.current.delete(hook); };
    }, []);

    const leave = props.leave ?? reloadTab;
    const leaveRef = React.useRef(leave);
    leaveRef.current = leave;
    const handOver = React.useCallback(async () => {
        logger.info("Handing over the app to another tab", {}, LOG_CTX);
        setStatus(GateStatus.HANDING_OVER);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), HAND_OVER_TIMEOUT_MS); });
        const stopped = Promise.all([...hooks.current].map(hook => hook().catch(error => {
            logger.error("Failed to stop a storage writer", { error: stringifyError(error) }, LOG_CTX);
        })));
        if (await Promise.race([stopped, timeout]) === 'timeout') {
            logger.warn("Storage writers did not stop in time", {}, LOG_CTX);
        }
        clearTimeout(timer);
        ownership.current = null;
        await leaveRef.current();
        setStatus(GateStatus.ELSEWHERE);
    }, [logger]);

    React.useEffect(() => {
        if (environment == null) {
            logger.warn("Web Locks are unavailable, tabs of the app are not coordinated", {}, LOG_CTX);
            return;
        }
        let cancelled = false;
        AppOwnership.tryAcquire(environment, handOver).then(acquired => {
            if (cancelled) {
                acquired?.dispose();
                return;
            }
            ownership.current = acquired;
            setStatus(acquired != null ? GateStatus.OWNER : GateStatus.ELSEWHERE);
        }, error => {
            logger.error("Failed to acquire the app", { error: stringifyError(error) }, LOG_CTX);
        });
        return () => {
            cancelled = true;
            ownership.current?.dispose();
            ownership.current = null;
        };
    }, [environment, handOver, logger]);

    const takeOver = React.useCallback(async () => {
        if (environment == null) {
            return;
        }
        setStatus(GateStatus.TAKING_OVER);
        try {
            ownership.current = await AppOwnership.takeOver(environment, handOver, TAKE_OVER_TIMEOUT_MS);
            logger.info("Took over the app from another tab", {}, LOG_CTX);
            setStatus(GateStatus.OWNER);
        } catch (error) {
            if (!(error instanceof AppOwnershipTimeoutError)) {
                logger.error("Failed to take over the app", { error: stringifyError(error) }, LOG_CTX);
            }
            setStatus(GateStatus.UNRESPONSIVE);
        }
    }, [environment, handOver, logger]);

    switch (status) {
        case GateStatus.ACQUIRING:
            return null;
        case GateStatus.OWNER:
            return <APP_HAND_OVER_CTX.Provider value={register}>{props.children}</APP_HAND_OVER_CTX.Provider>;
        case GateStatus.HANDING_OVER:
            // The app stays mounted until its writers stopped, the page blocks further edits
            return (
                <APP_HAND_OVER_CTX.Provider value={register}>
                    {props.children}
                    <div className={styles.overlay}>
                        <AppElsewherePage status={status} />
                    </div>
                </APP_HAND_OVER_CTX.Provider>
            );
        default:
            return <AppElsewherePage status={status} onTakeOver={takeOver} />;
    }
};

function AppElsewherePage(props: { status: GateStatus; onTakeOver?: () => void }) {
    let description: string;
    switch (props.status) {
        case GateStatus.HANDING_OVER:
            description = 'DashQL is moving to another tab.';
            break;
        case GateStatus.UNRESPONSIVE:
            description = 'The other tab did not respond. Close it and try again.';
            break;
        default:
            description = 'DashQL is open in another tab. Only one tab can use the app at a time, so that tabs don\'t overwrite each other\'s changes.';
            break;
    }
    return (
        <div className={`${baseStyles.page} ${styles.page}`} data-electron-drag-region>
            <ParticleFlowBackground />
            {/* The internals need the storage, which another tab owns */}
            <CompactNavBar showInternals={false} />
            <div className={`${baseStyles.banner_and_content_container} ${styles.foreground}`} data-electron-drag-region>
                <div className={baseStyles.content_container} data-electron-drag-region>
                    <div className={`${baseStyles.card} ${styles.card}`}>
                        <div className={baseStyles.card_header} data-electron-drag-region>
                            <div className={baseStyles.card_header_left_container}>
                                <div className={baseStyles.card_header_left_title}>
                                    Open in Another Tab
                                </div>
                            </div>
                        </div>
                        <div className={baseStyles.card_section}>
                            <div className={`${baseStyles.section_entries} ${styles.description}`}>
                                {description}
                            </div>
                            {props.onTakeOver && (
                                <div className={baseStyles.card_actions}>
                                    <div className={baseStyles.card_actions_right}>
                                        <Button
                                            variant={ButtonVariant.Primary}
                                            onClick={props.onTakeOver}
                                            disabled={props.status === GateStatus.TAKING_OVER}
                                        >
                                            Use Here
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
}
