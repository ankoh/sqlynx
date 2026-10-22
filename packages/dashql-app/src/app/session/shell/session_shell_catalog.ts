import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK } from '../../connections/catalog_update_state.js';
import { DashQLShell, DashQLShellEnvironment, DashQLShellOptions } from '../../../shell/api.js';

export interface SessionShellCatalog {
    relationsSql: string;
    functionsSql: string;
}

export async function createSessionShell(
    catalog: SessionShellCatalog,
    environment: DashQLShellEnvironment,
    options: Omit<DashQLShellOptions, 'environment'> = {},
): Promise<DashQLShell> {
    const shell = await DashQLShell.create({ ...options, environment });
    try {
        shell.loadCatalogScript(catalog.relationsSql, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK);
        shell.loadCatalogScript(catalog.functionsSql, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK);
        return shell;
    } catch (error) {
        shell.destroy();
        throw error;
    }
}
