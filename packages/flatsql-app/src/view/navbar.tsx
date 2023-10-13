import * as React from 'react';
import classNames from 'classnames';
import { SystemBar } from './systembar';
import { Link, useLocation } from 'react-router-dom';
import { useActiveGitHubProfile } from '../github';
import { useAppConfig } from '../state/app_config';
import { HoverMode, LinkButton } from './button';

import styles from './navbar.module.css';

import logo from '../../static/svg/logo/logo.svg';
import icon_explorer from '../../static/svg/icons/file_document_multiple.svg';
import icon_account from '../../static/svg/icons/folder_account.svg';
import icon_connection from '../../static/svg/icons/connection.svg';

const Tab = (props: { route: string; alt?: string; location: string; icon: string }) => (
    <div
        key={props.route}
        className={classNames(styles.tab, {
            [styles.active]: props.location == props.route || props.location == props.alt,
        })}
    >
        <LinkButton className={styles.tab_link} to={props.route} hover={HoverMode.Darken}>
            <svg width="20px" height="20px">
                <use xlinkHref={`${props.icon}#sym`} />
            </svg>
        </LinkButton>
    </div>
);

export const NavBar = (): React.ReactElement => {
    const appConfig = useAppConfig();
    const location = useLocation();
    const ghProfile = useActiveGitHubProfile();
    return (
        <div className={styles.navbar}>
            <Link className={styles.logo} to="/">
                <svg width="28px" height="28px">
                    <use xlinkHref={`${logo}#sym`} />
                </svg>
            </Link>
            <div className={styles.tabs}>
                <Tab route="/" location={location.pathname} icon={icon_explorer} />
                <Tab route="/databases" location={location.pathname} icon={icon_connection} />
            </div>
            {appConfig?.value?.features?.userAccount && (
                <Link className={styles.account} to="/account">
                    {ghProfile?.avatarUrl ? (
                        <img className={styles.avatar} width="32px" height="32px" src={ghProfile!.avatarUrl} />
                    ) : (
                        <svg className={styles.avatar} width="26px" height="26px">
                            <use xlinkHref={`${icon_account}#sym`} />
                        </svg>
                    )}
                </Link>
            )}
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
                <NavBar />
                <div className={styles.page}>
                    <Component {...props} />
                </div>
            </div>
        );
    };
}
