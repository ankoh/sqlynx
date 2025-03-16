import { VariantKind } from "utils/variant.js";
import { PlatformFile } from "./file.js";

export const DROP_EVENT = Symbol("DROP_EVENT");
export const DRAG_EVENT = Symbol("DRAG_EVENT");
export const DRAG_STOP_EVENT = Symbol("DRAG_STOP_EVENT");

/// A drag event
export interface PlatformDragEvent {
    /// The page x-coordinate value
    pageX: number;
    /// The page y-coordinate value
    pageY: number;
}

export interface PlatformDropEvent extends PlatformDragEvent {
    /// The file
    file: PlatformFile;
}

export type PlatformDragDropEventVariant =
    | VariantKind<typeof DRAG_EVENT, PlatformDragEvent>
    | VariantKind<typeof DRAG_STOP_EVENT, null>
    | VariantKind<typeof DROP_EVENT, PlatformDropEvent>
    ;
