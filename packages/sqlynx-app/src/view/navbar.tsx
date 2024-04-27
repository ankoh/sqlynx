import * as React from 'react';
import { useLocation } from 'react-router-dom';

import { SQLYNX_VERSION } from '../globals.js';
import { classNames } from '../utils/classnames.js';
import { HoverMode, NavBarLink, NavBarButtonWithRef } from './navbar_button.js';
import { PlatformType, usePlatformType } from '../platform/platform_type.js';
import { LogViewerInPortal } from './log_viewer.js';
import { VersionViewerInPortal } from './version_viewer.js';
import { SessionLinkTarget, generateSessionSetupUrl } from '../session/session_setup_url.js';
import { useCurrentSessionState } from '../session/current_session.js';
import { useConnectionState } from '../connectors/connection_registry.js';

import * as styles from './navbar.module.css';

import * as symbols from '../../static/svg/symbols.generated.svg';

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
    const [isOpen, setIsOpen] = React.useState<boolean>(false);
    return (
        <div className={styles.tab}>
            <NavBarButtonWithRef className={styles.tab_button} hover={HoverMode.Darken} onClick={() => setIsOpen(s => !s)}>
                <>
                    <svg width="14px" height="14px">
                        <use xlinkHref={`${symbols}#log`} />
                    </svg>
                    <span className={styles.tab_button_text}>Logs</span>
                </>
            </NavBarButtonWithRef>
            {isOpen && <LogViewerInPortal onClose={() => setIsOpen(false)} />}
        </div>
    );
}

const UpdateButton = (_props: {}) => {
    const [isOpen, setIsOpen] = React.useState<boolean>(false);
    return (
        <div className={styles.tab}>
            <NavBarButtonWithRef className={styles.tab_button} hover={HoverMode.Darken} onClick={() => setIsOpen(s => !s)}>
                <>
                    <svg width="14px" height="14px">
                        <use xlinkHref={`${symbols}#package`} />
                    </svg>
                    <span className={styles.tab_button_text}>{SQLYNX_VERSION}</span>
                </>
            </NavBarButtonWithRef>
            {isOpen && <VersionViewerInPortal onClose={() => setIsOpen(false)} />}
        </div>
    );
};

export const NavBar = (): React.ReactElement => {
    const location = useLocation();
    const platformType = usePlatformType();
    const [sessionState, _modifySessionState] = useCurrentSessionState();
    const [connectionState, _setConnectionState] = useConnectionState(sessionState?.connectionId ?? null);

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

export function withNavBar<P extends React.JSX.IntrinsicAttributes>(
    Component: React.ComponentType<P>,
): React.FunctionComponent<P> {
    // eslint-disable-next-line react/display-name
    return (props: P) => {
        return (
            <div className={styles.container}>
                <NavBar />
                <div className={styles.page_container}>
                    <Component {...props} />
                </div>
            </div>
        );
    };
}
