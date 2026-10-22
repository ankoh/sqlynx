// Re-export all cell components from their individual files

export { HeaderNameCell, type HeaderNameCellProps } from './data_table_cell_header_name.js';
export { HeaderPlotsCell, type HeaderPlotsCellProps } from './data_table_cell_header_plots.js';
export { DataCell, type DataCellData } from './data_table_cell_data.js';

export enum TableColumnHeader {
    OnlyColumnName = 0,
    WithColumnPlots = 1
}
