import * as React from 'react';
import * as styles from './navbar.module.css';
import * as symbols from '../../static/svg/symbols.generated.svg';

import { useLocation } from 'react-router-dom';

import { SQLYNX_VERSION } from '../globals.js';
import { classNames } from '../utils/classnames.js';
import { HoverMode, NavBarButtonWithRef, NavBarLink } from './navbar_button.js';
import { PlatformType, usePlatformType } from '../platform/platform_type.js';
import { VersionInfoOverlay } from './version_viewer.js';
import { generateSessionSetupUrl, SessionLinkTarget } from '../session/session_setup_url.js';
import { useCurrentSessionState } from '../session/current_session.js';
import { useConnectionState } from '../connectors/connection_registry.js';
import { useAppConfig } from '../app_config.js';
import { useLogger } from '../platform/logger_provider.js';
import { useVersionCheck } from '../platform/version_check.js';
import { VersionCheckIndicator } from './version_viewer.js';
import { AnchorAlignment, AnchorSide } from './foundations/anchored_position.js';
import { LogViewerOverlay } from './log_viewer.js';
import { OverlaySize } from './foundations/overlay.js';
import { InternalsViewerOverlay } from './internals_viewer.js';

const LOG_CTX = "navbar";

const PageTab = (props: { route: string; alt?: string; location: string; icon: string; label: string | null }) => (
    <div
        key={props.route}
        className={classNames(styles.tab, {
            [styles.active]: props.location == props.route || props.location == props.alt,
        })}
    >
        <NavBarLink className={styles.tab_button} to={props.route} hover={HoverMode.Darken}>
            <>
                <svg width="16px" height="16px">
                    <use xlinkHref={props.icon} />
                </svg>
                {props.label && <span className={styles.tab_button_text}>{props.label}</span>}
            </>
        </NavBarLink>
    </div>
);

const OpenIn = (props: { url?: string | null; alt?: string; icon?: string; label: string, newWindow?: boolean }) => (
    <div className={styles.tab}>
        <NavBarLink className={styles.tab_button} to={props.url ?? ""} hover={HoverMode.Darken} newWindow={props.newWindow}>
            <>
                {props.icon &&
                    <svg width="16px" height="16px">
                        <use xlinkHref={props.icon} />
                    </svg>
                }
                <span className={styles.tab_button_text}>{props.label}</span>
            </>
        </NavBarLink>
    </div>
);

const LogButton = () => {
    const [showLogOverlay, setShowLogOverlay] = React.useState<boolean>(false);
    return (
        <div className={styles.tab}>
            <LogViewerOverlay
                isOpen={showLogOverlay}
                onClose={() => setShowLogOverlay(false)}
                renderAnchor={(p: object) => (
                    <NavBarButtonWithRef
                        {...p}
                        className={styles.tab_button}
                        hover={HoverMode.Darken} onClick={() => setShowLogOverlay(true)}>
                        <>
                            <svg width="14px" height="14px">
                                <use xlinkHref={`${symbols}#log`} />
                            </svg>
                            <span className={styles.tab_button_text}>Logs</span>
                        </>
                    </NavBarButtonWithRef>
                )}
                side={AnchorSide.OutsideBottom}
                align={AnchorAlignment.End}
                anchorOffset={16}
                overlayProps={{
                    width: OverlaySize.XL,
                    height: OverlaySize.XL
                }}
            />
        </div>
    );
}

const InternalsButton = (_props: {}) => {
    const [showInternalsViewerOverlay, setInternalsViewerOverlay] = React.useState<boolean>(false);

    return (
        <div className={styles.tab}>
            <InternalsViewerOverlay
                isOpen={showInternalsViewerOverlay}
                onClose={() => setInternalsViewerOverlay(false)}
                renderAnchor={(p: object) => (
                    <NavBarButtonWithRef
                        {...p}
                        className={styles.tab_button} hover={HoverMode.Darken} onClick={() => setInternalsViewerOverlay(true)}
                    >
                        <>
                            <svg width="14px" height="14px">
                                <use xlinkHref={`${symbols}#processor`} />
                            </svg>
                            <span className={styles.tab_button_text}>Internals</span>
                        </>
                    </NavBarButtonWithRef>
                )}
                side={AnchorSide.OutsideBottom}
                align={AnchorAlignment.End}
                anchorOffset={16}
            />
        </div>
    );
};

const VersionButton = (_props: {}) => {
    const [showVersionOverlay, setShowVersionOverlay] = React.useState<boolean>(false);
    const versionCheck = useVersionCheck();

    return (
        <div className={styles.tab}>
            <VersionInfoOverlay
                isOpen={showVersionOverlay}
                onClose={() => setShowVersionOverlay(false)}
                renderAnchor={(p: object) => (
                    <NavBarButtonWithRef
                        {...p}
                        className={styles.tab_button} hover={HoverMode.Darken} onClick={() => setShowVersionOverlay(true)}
                    >
                        <>
                            <VersionCheckIndicator status={versionCheck} />
                            <span className={styles.tab_button_text}>{SQLYNX_VERSION}</span>
                        </>
                    </NavBarButtonWithRef>
                )}
                side={AnchorSide.OutsideBottom}
                align={AnchorAlignment.End}
                anchorOffset={16}
            />
        </div>
    );
};

export const NavBar = (): React.ReactElement => {
    const logger = useLogger();
    const location = useLocation();
    const platformType = usePlatformType();
    const [sessionState, _modifySessionState] = useCurrentSessionState();
    const [connectionState, _setConnectionState] = useConnectionState(sessionState?.connectionId ?? null);
    const appConfig = useAppConfig();

    const isBrowser = platformType === PlatformType.WEB;
    const isMac = platformType === PlatformType.MACOS;
    const setupLinkTarget = isBrowser ? SessionLinkTarget.NATIVE : SessionLinkTarget.WEB;
    const setupUrl = React.useMemo(() => {
        if (sessionState == null || connectionState == null) {
            return null;
        }
        return generateSessionSetupUrl(sessionState, connectionState, setupLinkTarget);
    }, [sessionState, connectionState, setupLinkTarget]);

    React.useEffect(() => {
        logger.info(`navigated to path ${location.pathname}`, LOG_CTX);
    }, [location.pathname]);

    return (
        <div className={isMac ? styles.navbar_mac : styles.navbar_default}
        >
            <div className={styles.tabs}
                data-tauri-drag-region="true"
            >
                <PageTab label="Editor" route="/" location={location.pathname} icon={`${symbols}#file`} />
                {appConfig.isResolved() && appConfig.value?.features?.files && (
                    <PageTab label="Files" route="/files" location={location.pathname} icon={`${symbols}#folder`} />
                )}
                <PageTab label="Connectors" route="/connectors" location={location.pathname} icon={`${symbols}#database`} />
            </div>
            <div className={styles.version_container}>
                <LogButton />
                <InternalsButton />
                <VersionButton />
                {isBrowser
                    ? <OpenIn label="Open in App" url={setupUrl?.toString()} icon={`${symbols}#download_desktop`} newWindow={false} />
                    : <OpenIn label="Open in Browser" url={setupUrl?.toString()} icon={`${symbols}#upload_browser`} newWindow={true} />
                }
            </div>
        </div>
    );
};

export function NavBarContainer(props: { children: React.ReactElement }) {
    return (
        <div className={styles.container}>
            <NavBar key={0} />
            <div key={1} className={styles.page_container}>
                {props.children}
            </div>
        </div>
    );
}
