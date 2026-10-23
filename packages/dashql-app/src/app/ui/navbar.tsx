import * as React from 'react';
import * as styles from './navbar.module.css';
import symbols from '@ankoh/dashql-svg-symbols';

import { AnchorAlignment, AnchorSide } from '../../ui/foundations/anchored_position.js';
import { Tag, TagVariant } from '../../ui/foundations/tag.js';
import { HoverMode, NavBarButton, NavBarButtonWithRef } from './navbar_button.js';
import { InternalsViewerOverlay } from './internals/internals_overlay.js';
import { PlatformType, usePlatformType } from '../../platform/platform_type.js';
import { DASHQL_VERSION } from '../../globals.js';
import { VersionCheckIndicator } from '../../ui/version/version_viewer.js';
import { VersionInfoOverlay } from '../../ui/version/version_viewer.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { SESSION_PATH, SELECT_SESSION, useRouteContext, useRouterNavigate } from '../router/router.js';
import { useVersionCheck } from '../../platform/version/version_check.js';
import { useLocation } from 'react-router-dom';
import { SessionViewMode, useSessionViewMode } from '../session/ui/session_view_mode.js';
import { FlavorLogo, useAppFlavor } from '../flavor/flavor_provider.js';

const LOG_CTX = "navbar";

const InternalsButton = (props: { sessionId: string | null }) => {
    const [showInternalsViewerOverlay, setInternalsViewerOverlay] = React.useState<boolean>(false);

    return (
        <div className={styles.tab}>
            <InternalsViewerOverlay
                sessionId={props.sessionId}
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

const SessionShellButton = () => {
    const { mode, setMode } = useSessionViewMode();
    const shellActive = mode === SessionViewMode.Shell;
    const label = shellActive ? 'Return to session' : 'Open shell';
    return (
        <div className={`${styles.tab} ${shellActive ? styles.active : ''}`}>
            <NavBarButton
                aria-label={shellActive ? 'Shell, return to session' : label}
                aria-pressed={shellActive}
                className={styles.tab_button}
                hover={HoverMode.Darken}
                onClick={() => setMode(shellActive ? SessionViewMode.Session : SessionViewMode.Shell)}
            >
                <>
                    <svg width="16px" height="16px" aria-hidden="true">
                        <use xlinkHref={`${symbols}#command_palette_24`} />
                    </svg>
                    <span className={styles.tab_button_text}>Shell</span>
                </>
            </NavBarButton>
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
                            <span className={styles.tab_button_text}>{DASHQL_VERSION}</span>
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

/// The height of a wordmark in the navbar, a bit smaller than square logos to match the cap height of text
const WORDMARK_HEIGHT = 16;

/// The brand mark followed by the tagline of the flavor, sharing the baseline
const BrandMark = (props: { children: React.ReactNode }) => {
    const tagline = useAppFlavor().tagline;
    if (tagline == null) {
        return <>{props.children}</>;
    }
    return (
        <span className={styles.brand_mark}>
            {props.children}
            <Tag variant={TagVariant.Outline} className={styles.brand_tagline}>{tagline}</Tag>
        </span>
    );
};

const BrandLogo = () => {
    const flavor = useAppFlavor();
    const route = useRouteContext();
    const navigate = useRouterNavigate();
    const { setMode } = useSessionViewMode();
    const openWorkbench = React.useCallback(() => {
        setMode(SessionViewMode.Session);
        navigate(route.sessionId == null
            ? { type: SESSION_PATH, value: null }
            : { type: SELECT_SESSION, value: route.sessionId });
    }, [navigate, route.sessionId, setMode]);

    return (
        <button type="button" className={styles.brand_logo} aria-label="Open session workbench" onClick={openWorkbench}>
            <BrandMark>
                <FlavorLogo height={flavor.logo.wordmark ? WORDMARK_HEIGHT : 24} ariaHidden />
            </BrandMark>
        </button>
    );
};

const BrandIdentity = () => {
    const flavor = useAppFlavor();
    return (
        <div className={styles.brand_identity} data-electron-drag-region>
            {flavor.logo.wordmark
                ? <BrandMark><FlavorLogo height={WORDMARK_HEIGHT} ariaHidden /></BrandMark>
                : <>
                    <FlavorLogo height={24} ariaHidden />
                    <BrandMark><span>{flavor.displayName}</span></BrandMark>
                </>}
        </div>
    );
};

export const CompactNavBar = (props: { showInternals?: boolean }): React.ReactElement => {
    const route = useRouteContext();
    const platform = usePlatformType();
    const navbarClass = platform === PlatformType.DESKTOP ? styles.navbar_mac : styles.navbar_default;

    return (
        <header className={`${navbarClass} ${styles.navbar_overlay}`} data-electron-drag-region>
            <BrandIdentity />
            <div className={styles.navbar_actions}>
                {(props.showInternals ?? true) && <InternalsButton sessionId={route.sessionId} />}
                <VersionButton />
            </div>
        </header>
    );
};

export const NavBar = (): React.ReactElement => {
    const logger = useLogger();
    const route = useRouteContext();
    const platform = usePlatformType();
    const location = useLocation();

    const isMac = platform === PlatformType.DESKTOP;

    React.useEffect(() => {
        logger.debug("Navigated to path", { "path": location.pathname }, LOG_CTX);
    }, [location.pathname]);

    const sessionId = route.sessionId;
    return (
        // Electron excludes the interactive controls below via the global no-drag rules.
        <div className={isMac ? styles.navbar_mac : styles.navbar_default}
            data-electron-drag-region
        >
            <BrandLogo />
            <div className={styles.navbar_actions}>
                {sessionId != null && <SessionShellButton />}
                <InternalsButton sessionId={sessionId} />
                <VersionButton />
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
