import * as React from 'react';
import { useLocation } from 'react-router-dom';

import { SQLYNX_VERSION } from '../globals.js';
import { classNames } from '../utils/classnames.js';
import { HoverMode, NavBarLink, NavBarButtonWithRef } from './navbar_button.js';
import { PlatformType, usePlatformType } from '../platform/platform_type.js';
import { LogViewerInPortal } from './log_viewer.js';
import { VersionViewerOverlay } from './version_viewer.js';
import { SessionLinkTarget, generateSessionSetupUrl } from '../session/session_setup_url.js';
import { useCurrentSessionState } from '../session/current_session.js';
import { useConnectionState } from '../connectors/connection_registry.js';

import * as styles from './navbar.module.css';
import * as symbols from '../../static/svg/symbols.generated.svg';
import { useAppConfig } from '../app_config.js';
import { Button, ButtonVariant } from './foundations/button.js';
import { PackageIcon } from '@primer/octicons-react';
import { AnchorAlignment, AnchorSide } from './foundations/anchored_position.js';

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

const ExternalLink = (props: { url?: string | null; alt?: string; icon?: string; label: string, newWindow?: boolean }) => (
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

const LogButton = (_props: {}) => {
    const [showVersionOverlay, setShowVersionOverlay] = React.useState<boolean>(false);
    return (
        <div className={styles.tab}>
            <NavBarButtonWithRef className={styles.tab_button} hover={HoverMode.Darken} onClick={() => setShowVersionOverlay(s => !s)}>
                <>
                    <svg width="14px" height="14px">
                        <use xlinkHref={`${symbols}#log`} />
                    </svg>
                    <span className={styles.tab_button_text}>Logs</span>
                </>
            </NavBarButtonWithRef>
            {showVersionOverlay && <LogViewerInPortal onClose={() => setShowVersionOverlay(false)} />}
        </div>
    );
}

const UpdateButton = (_props: {}) => {
    const [showVersionOverlay, setShowVersionOverlay] = React.useState<boolean>(false);
    return (
        <div className={styles.tab}>
            <VersionViewerOverlay
                isOpen={showVersionOverlay}
                onClose={() => setShowVersionOverlay(false)}
                renderAnchor={(p: object) => (
                    <NavBarButtonWithRef
                        {...p}
                        className={styles.tab_button} hover={HoverMode.Darken} onClick={() => setShowVersionOverlay(true)}
                    >
                        <>
                            <svg width="14px" height="14px">
                                <use xlinkHref={`${symbols}#package`} />
                            </svg>
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
                <UpdateButton />
                {isBrowser
                    ? <ExternalLink label="Open in App" url={setupUrl?.toString()} icon={`${symbols}#download_desktop`} newWindow={false} />
                    : <ExternalLink label="Open in Browser" url={setupUrl?.toString()} icon={`${symbols}#upload_browser`} newWindow={true} />
                }
            </div>
        </div>
    );
};

export function NavBarContainer(props: { children: React.ReactElement }){
    return (
        <div className={styles.container}>
            <NavBar key={0} />
            <div key={1} className={styles.page_container}>
                {props.children}
            </div>
        </div>
    );
}
