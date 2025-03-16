import { VariantKind } from "utils/variant.js";
import { PlatformFile } from "./file.js";

export const DRAG_EVENT = Symbol("DRAG_EVENT");
export const DROP_EVENT = Symbol("DROP_EVENT");

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

export type DragDropEventVariant =
    | VariantKind<typeof DRAG_EVENT, PlatformDragEvent>
    | VariantKind<typeof DROP_EVENT, PlatformDropEvent>
    ;
