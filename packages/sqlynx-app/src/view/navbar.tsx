import * as React from 'react';
import classNames from 'classnames';
import { SystemBar } from './systembar';
import { useLocation } from 'react-router-dom';
import { useActiveGitHubProfile } from '../github';
import { useAppConfig } from '../app_config';
import { HoverMode, LinkButton } from './button';
import { useElectronContext } from '../electron_context';

import styles from './navbar.module.css';

import symbols from '../../static/svg/symbols.generated.svg';

const Tab = (props: { route: string; alt?: string; location: string; icon: string; label: string }) => (
    <div
        key={props.route}
        className={classNames(styles.tab, {
            [styles.active]: props.location == props.route || props.location == props.alt,
        })}
    >
        <LinkButton className={styles.tab_link} to={props.route} hover={HoverMode.Darken}>
            <svg width="18px" height="18px">
                <use xlinkHref={props.icon} />
            </svg>
        </LinkButton>
    </div>
);

export const NavBar = (): React.ReactElement => {
    const appConfig = useAppConfig();
    const location = useLocation();
    const ghProfile = useActiveGitHubProfile();

    const isMac = useElectronContext()?.platform === 'darwin';
    return (
        <div className={isMac ? styles.navbar_mac : styles.navbar_default}>
            <div className={styles.tabs}>
                <Tab label="Editor" route="/" location={location.pathname} icon={`${symbols}#file_document_multiple`} />
                {appConfig?.value?.features?.connections && (
                    <Tab
                        label="Connections"
                        route="/connections"
                        location={location.pathname}
                        icon={`${symbols}#connection`}
                    />
                )}
            </div>
            <SystemBar className={styles.sysbar} />
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
                <div className={styles.center_container}>
                    <NavBar />
                    <div className={styles.page_container}>
                        <Component {...props} className={styles.page} />
                    </div>
                </div>
            </div>
        );
    };
}
