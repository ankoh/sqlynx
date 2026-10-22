import * as React from 'react';
import * as styles from './data_table.module.css';

interface GridApi {
    element: HTMLDivElement | null;
}

export interface DataTablePortalContainers {
    header: HTMLDivElement;
    data: HTMLDivElement;
}

export function useDataTablePortalContainers(gridApi: GridApi | null): DataTablePortalContainers | null {
    const [containers, setContainers] = React.useState<DataTablePortalContainers | null>(null);

    React.useEffect(() => {
        const gridElement = gridApi?.element;
        if (!gridElement) {
            setContainers(null);
            return;
        }
        const header = document.createElement('div');
        header.className = styles.sticky_header_portal;
        gridElement.prepend(header);

        const data = document.createElement('div');
        data.className = styles.sticky_column_portal;
        gridElement.appendChild(data);

        setContainers({ header, data });
        return () => {
            header.remove();
            data.remove();
            setContainers(null);
        };
    }, [gridApi]);

    return containers;
}
