import * as React from 'react';
import * as styles from './navbar.module.css';
import symbols from '@ankoh/dashql-svg-symbols';

import { AnchorAlignment, AnchorSide } from '../../ui/foundations/anchored_position.js';
import { HoverMode, NavBarButton, NavBarButtonWithRef } from './navbar_button.js';
import { InternalsViewerOverlay } from './internals/internals_overlay.js';
import { PlatformType, usePlatformType } from '../../platform/platform_type.js';
import { DASHQL_VERSION } from '../../globals.js';
import { VersionCheckIndicator } from '../../ui/version/version_viewer.js';
import { VersionInfoOverlay } from '../../ui/version/version_viewer.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { NOTEBOOK_PATH, SELECT_NOTEBOOK, useRouteContext, useRouterNavigate } from '../router/router.js';
import { useVersionCheck } from '../../platform/version/version_check.js';
import { useLocation } from 'react-router-dom';
import { NotebookViewMode, useNotebookViewMode } from '../notebook/scripts/notebook_commands.js';
import { FlavorLogo, useAppFlavor } from '../flavor/flavor_provider.js';

const LOG_CTX = "navbar";

const InternalsButton = (props: { notebookId: string | null }) => {
    const [showInternalsViewerOverlay, setInternalsViewerOverlay] = React.useState<boolean>(false);

    return (
        <div className={styles.tab}>
            <InternalsViewerOverlay
                notebookId={props.notebookId}
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

const NotebookShellButton = () => {
    const { mode, setMode } = useNotebookViewMode();
    const shellActive = mode === NotebookViewMode.Shell;
    const label = shellActive ? 'Return to notebook' : 'Open shell';
    return (
        <div className={`${styles.tab} ${shellActive ? styles.active : ''}`}>
            <NavBarButton
                aria-label={shellActive ? 'Shell, return to notebook' : label}
                aria-pressed={shellActive}
                className={styles.tab_button}
                hover={HoverMode.Darken}
                onClick={() => setMode(shellActive ? NotebookViewMode.Notebook : NotebookViewMode.Shell)}
            >
                <>
                    <svg width="16px" height="16px" aria-hidden="true">
                        <use xlinkHref={`${symbols}#shell_24`} />
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

const BrandLogo = () => {
    const flavor = useAppFlavor();
    const route = useRouteContext();
    const navigate = useRouterNavigate();
    const { setMode } = useNotebookViewMode();
    const openWorkbench = React.useCallback(() => {
        setMode(NotebookViewMode.Notebook);
        navigate(route.notebookId == null
            ? { type: NOTEBOOK_PATH, value: null }
            : { type: SELECT_NOTEBOOK, value: route.notebookId });
    }, [navigate, route.notebookId, setMode]);

    return (
        <button type="button" className={styles.brand_logo} aria-label="Open notebook workbench" onClick={openWorkbench}>
            <FlavorLogo height={flavor.logo.wordmark ? WORDMARK_HEIGHT : 24} ariaHidden />
        </button>
    );
};

const BrandIdentity = () => {
    const flavor = useAppFlavor();
    return (
        <div className={styles.brand_identity} data-electron-drag-region>
            {flavor.logo.wordmark
                ? <FlavorLogo height={WORDMARK_HEIGHT} ariaHidden />
                : <>
                    <FlavorLogo height={24} ariaHidden />
                    <span>{flavor.displayName}</span>
                </>}
        </div>
    );
};

export const CompactNavBar = (): React.ReactElement => {
    const route = useRouteContext();
    const platform = usePlatformType();
    const navbarClass = platform === PlatformType.MACOS ? styles.navbar_mac : styles.navbar_default;

    return (
        <header className={`${navbarClass} ${styles.navbar_overlay}`} data-electron-drag-region>
            <BrandIdentity />
            <div className={styles.navbar_actions}>
                <InternalsButton notebookId={route.notebookId} />
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

    const isMac = platform === PlatformType.MACOS;

    React.useEffect(() => {
        logger.debug("Navigated to path", { "path": location.pathname }, LOG_CTX);
    }, [location.pathname]);

    const notebookId = route.notebookId;
    return (
        // Electron excludes the interactive controls below via the global no-drag rules.
        <div className={isMac ? styles.navbar_mac : styles.navbar_default}
            data-electron-drag-region
        >
            <BrandLogo />
            <div className={styles.navbar_actions}>
                {notebookId != null && <NotebookShellButton />}
                <InternalsButton notebookId={notebookId} />
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
