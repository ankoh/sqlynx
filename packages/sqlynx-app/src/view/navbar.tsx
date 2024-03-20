import * as React from 'react';
import { useLocation } from 'react-router-dom';
import { classNames } from '../utils/classnames.js';
import { HoverMode, LinkButton } from './button.js';
import { PlatformType } from '../platform/platform_api.js';
import { usePlatformApi } from '../platform/platform_api_provider.js';
import { useSessionLinks } from '../session/session_link_manager.js';
import { SQLYNX_GET_URL, SQLYNX_GIT_COMMIT, SQLYNX_GIT_REPO_URL, SQLYNX_VERSION } from '../app_version.js';

import styles from './navbar.module.css';

import * as symbols from '../../static/svg/symbols.generated.svg';

const PageTab = (props: { route: string; alt?: string; location: string; icon: string; label: string | null }) => (
    <div
        key={props.route}
        className={classNames(styles.tab, {
            [styles.active]: props.location == props.route || props.location == props.alt,
        })}
    >
        <LinkButton className={styles.tab_link} to={props.route} hover={HoverMode.Darken}>
            <>
                <svg width="16px" height="16px">
                    <use xlinkHref={props.icon} />
                </svg>
                {props.label && <span className={styles.tab_link_text}>{props.label}</span>}
            </>
        </LinkButton>
    </div>
);

const ExternalLink = (props: { url?: string | null; alt?: string; icon?: string; label: string, newWindow?: boolean }) => (
    <div className={styles.tab}>
        <LinkButton className={styles.tab_link} to={props.url ?? ""} hover={HoverMode.Darken} newWindow={props.newWindow}>
            <>
                {props.icon &&
                    <svg width="16px" height="16px">
                        <use xlinkHref={props.icon} />
                    </svg>
                }
                <span className={styles.tab_link_text}>{props.label}</span>
            </>
        </LinkButton>
    </div>
);

export const NavBar = (): React.ReactElement => {
    const location = useLocation();
    const platform = usePlatformApi();
    const isBrowser = platform?.getPlatformType() === PlatformType.WEB;
    const isMac = platform?.getPlatformType() === PlatformType.MACOS;
    const sessionLinks = useSessionLinks();
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
                <ExternalLink label={SQLYNX_VERSION} url={SQLYNX_GET_URL} icon={`${symbols}#package`} newWindow={true} />
                <ExternalLink label={SQLYNX_GIT_COMMIT} url={SQLYNX_GIT_REPO_URL} icon={`${symbols}#github`} newWindow={true} />
                <ExternalLink label={SQLYNX_GIT_COMMIT} url={SQLYNX_GIT_REPO_URL} icon={`${symbols}#github`} newWindow={true} />
                {isBrowser
                    ? <ExternalLink label="Open in App" url={sessionLinks?.privateDeepLink.toString()} icon={`${symbols}#download_desktop`} newWindow={false} />
                    : <ExternalLink label="Open in Browser" url={sessionLinks?.privateWebLink.toString()} icon={`${symbols}#upload_browser`} newWindow={true} />
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
