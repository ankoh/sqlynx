import * as React from 'react';
import icons from '@ankoh/dashql-svg-symbols';

export type IconSize = number | 'small' | 'medium' | 'large';

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'size' | 'title'> {
    size?: IconSize;
    title?: string;
    verticalAlign?: React.CSSProperties['verticalAlign'];
}

export type Icon = React.FC<IconProps>;

type SymbolVariants = Readonly<Record<number, string>>;

const ICON_SIZE: Record<Exclude<IconSize, number>, number> = {
    small: 16,
    medium: 32,
    large: 64,
};

function resolveSize(size: IconSize | undefined): number {
    if (typeof size === 'number') {
        return size;
    }
    return size == null ? 16 : ICON_SIZE[size];
}

function resolveSymbol(variants: SymbolVariants, size: number): string {
    const naturalSizes = Object.keys(variants).map(Number).sort((a, b) => a - b);
    let naturalSize = naturalSizes[0];
    for (const candidate of naturalSizes) {
        if (candidate > size) {
            break;
        }
        naturalSize = candidate;
    }
    return variants[naturalSize];
}

function createIcon(variants: SymbolVariants): Icon {
    return React.forwardRef<SVGSVGElement, IconProps>((props, ref) => {
        const {
            'aria-label': ariaLabel,
            'aria-labelledby': ariaLabelledBy,
            className,
            fill = 'currentColor',
            size,
            style,
            tabIndex,
            title,
            verticalAlign = 'text-bottom',
            ...svgProps
        } = props;
        const pixels = resolveSize(size);
        const labelled = Boolean(ariaLabel || ariaLabelledBy);
        const symbol = resolveSymbol(variants, pixels);

        return (
            <svg
                ref={ref}
                {...svgProps}
                aria-hidden={labelled ? undefined : 'true'}
                aria-label={ariaLabel}
                aria-labelledby={ariaLabelledBy}
                className={className}
                color={fill}
                display="inline-block"
                fill="currentColor"
                focusable={tabIndex != null && tabIndex >= 0 ? 'true' : 'false'}
                height={pixels}
                overflow="visible"
                role={labelled ? 'img' : undefined}
                style={{ verticalAlign, ...style }}
                tabIndex={tabIndex}
                width={pixels}
            >
                {title != null && <title>{title}</title>}
                <use xlinkHref={`${icons}#${symbol}`} />
            </svg>
        );
    });
}

const SYMBOL_ICONS = new Map<string, Icon>();

export function SymbolIcon(symbol: string): Icon {
    const cached = SYMBOL_ICONS.get(symbol);
    if (cached != null) {
        return cached;
    }
    const icon = createIcon({ 16: symbol });
    SYMBOL_ICONS.set(symbol, icon);
    return icon;
}

export const AlertIcon = createIcon({ 16: 'alert_16' });
export const BeakerIcon = createIcon({ 16: 'beaker_16', 24: 'beaker_24' });
export const BookIcon = createIcon({ 16: 'book_16', 24: 'book_24' });
export const CheckIcon = createIcon({ 16: 'check_16', 24: 'check_24' });
export const ChecklistIcon = createIcon({ 16: 'checklist_16' });
export const ChevronDownIcon = createIcon({ 12: 'chevron_down_12', 16: 'chevron_down_16', 24: 'chevron_down_24' });
export const ChevronLeftIcon = createIcon({ 12: 'chevron_left_12', 16: 'chevron_left_16', 24: 'chevron_left_24' });
export const ChevronRightIcon = createIcon({ 12: 'chevron_right_12', 16: 'chevron_right_16', 24: 'chevron_right_24' });
export const ChevronUpIcon = createIcon({ 12: 'chevron_up_12', 16: 'chevron_up_16', 24: 'chevron_up_24' });
export const CircleSlashIcon = createIcon({ 16: 'circle_slash_16', 24: 'circle_slash' });
export const CodeIcon = createIcon({ 16: 'code_16' });
export const ComposeIcon = createIcon({ 16: 'compose_16', 24: 'compose_24' });
export const CopyIcon = createIcon({ 16: 'copy_16' });
export const DashIcon = createIcon({ 16: 'dash_16' });
export const DatabaseIcon = createIcon({ 16: 'database_16', 24: 'database' });
export const DownloadIcon = createIcon({ 16: 'download_16', 24: 'download' });
export const EyeIcon = createIcon({ 16: 'eye_16', 24: 'eye_24' });
export const FileBadgeIcon = createIcon({ 16: 'file_badge_16' });
export const FileDirectoryFillIcon = createIcon({ 16: 'file_directory_fill_16', 24: 'folder_fill' });
export const FileDirectoryIcon = createIcon({ 16: 'file_directory_16', 24: 'folder' });
export const FileDirectoryOpenFillIcon = createIcon({ 16: 'file_directory_open_fill_16' });
export const FileIcon = createIcon({ 16: 'file_16', 24: 'file' });
export const GraphIcon = createIcon({ 16: 'graph_16', 24: 'graph_24' });
export const HeartIcon = createIcon({ 16: 'heart_16' });
export const HistoryIcon = createIcon({ 16: 'history_16' });
export const KeyIcon = createIcon({ 16: 'key_16' });
export const LinkIcon = createIcon({ 16: 'link_16' });
export const ListUnorderedIcon = createIcon({ 16: 'list_unordered_16' });
export const LockIcon = createIcon({ 16: 'lock_16' });
export const PaperAirplaneIcon = createIcon({ 16: 'paper_airplane_16' });
export const PaperclipIcon = createIcon({ 16: 'paperclip_16' });
export const PersonIcon = createIcon({ 16: 'person_16', 24: 'person_24' });
export const PlugIcon = createIcon({ 16: 'plug_16', 24: 'plug_24' });
export const PlusIcon = createIcon({ 16: 'plus_16', 24: 'plus_24' });
export const ProjectIcon = createIcon({ 16: 'project_16' });
export const RowsIcon = createIcon({ 16: 'rows_16', 24: 'rows' });
export const SaveIcon = createIcon({ 16: 'save_16' });
export const SearchIcon = createIcon({ 16: 'search_16' });
export const ScreenFullIcon = createIcon({ 16: 'screen_full_16', 24: 'screen_full_24' });
export const ScreenNormalIcon = createIcon({ 16: 'screen_normal_16', 24: 'screen_normal_24' });
export const StackCheckIcon = createIcon({ 16: 'stack_check_16', 24: 'stack_check_24' });
export const SquareFillIcon = createIcon({ 16: 'square_fill_16' });
export const SyncIcon = createIcon({ 16: 'sync_16' });
export const TableIcon = createIcon({ 16: 'table_16' });
export const ThreeBarsIcon = createIcon({ 16: 'three_bars_16' });
export const TrashIcon = createIcon({ 16: 'trash_16', 24: 'trash_24' });
export const TriangleDownIcon = createIcon({ 16: 'triangle_down_16', 24: 'triangle_down_24' });
export const UnlinkIcon = createIcon({ 16: 'unlink_16' });
export const XCircleFillIcon = createIcon({ 16: 'x_circle_16' });
export const XIcon = createIcon({ 12: 'x_12', 16: 'x_16', 24: 'x_24' });
export const ZoomInIcon = createIcon({ 16: 'zoom_in_16' });
export const ZoomOutIcon = createIcon({ 16: 'zoom_out_16' });
