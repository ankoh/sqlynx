import * as React from 'react';
import * as styles from './mostfrequent_cell.module.css';

import { ColumnSummaryVariant, TableSummary } from '../../compute/table_transforms.js';
import { dataTypeToString } from './arrow_formatter.js';

interface MostFrequentCellProps {
    tableSummary: TableSummary;
    columnSummary: ColumnSummaryVariant;
}

export function MostFrequentCell(props: MostFrequentCellProps): React.ReactElement {
    const rootContainer = React.useRef<HTMLDivElement>(null);

    if (props.columnSummary.value == null) {
        return <div />;
    }

    return (
        <div className={styles.root} ref={rootContainer}>
            <div className={styles.header_container}>
                {dataTypeToString(props.columnSummary.value.columnEntry.inputFieldType)}
            </div>
        </div>
    );
}
