import * as React from 'react';
import classNames from 'classnames';
import { SystemBar } from './systembar';
import { Link, useLocation } from 'react-router-dom';
import { useActiveGitHubProfile } from '../github';
import { useAppConfig } from '../app_config';
import { HoverMode, LinkButton } from './button';

import styles from './navbar.module.css';

import symbols from '../../static/svg/symbols.generated.svg';

const Tab = (props: { route: string; alt?: string; location: string; icon: string }) => (
    <div
        key={props.route}
        className={classNames(styles.tab, {
            [styles.active]: props.location == props.route || props.location == props.alt,
        })}
    >
        <LinkButton className={styles.tab_link} to={props.route} hover={HoverMode.Darken}>
            <svg width="20px" height="20px">
                <use xlinkHref={props.icon} />
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
                <svg width="30px" height="30px">
                    <use xlinkHref={`${symbols}#sqlynx`} />
                </svg>
            </Link>
            <div className={styles.tabs}>
                <Tab route="/" location={location.pathname} icon={`${symbols}#file_document_multiple`} />
                {appConfig?.value?.features?.connections && (
                    <Tab route="/connections" location={location.pathname} icon={`${symbols}#connection`} />
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
                <NavBar />
                <div className={styles.page}>
                    <Component {...props} />
                </div>
            </div>
        );
    };
}
