import * as app_event from '@ankoh/dashql-jsonschema/app_event.js';

import { VariantKind } from "../../utils/variant.js";
import { PlatformFile } from "../file/file.js";

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


export const OAUTH_BROADCAST_CHANNEL = "dashql_oauth";

/// Envelope kind for app events sent via window.postMessage.
/// Required because a global window "message" listener otherwise receives
/// unrelated traffic (devtools bridges, extensions, etc.).
export const APP_EVENT_POST_MESSAGE_KIND = "dashql:app_event";

export interface AppEventPostMessage {
    kind: typeof APP_EVENT_POST_MESSAGE_KIND;
    data: string;
}

export function isAppEventPostMessage(msg: any): msg is AppEventPostMessage {
    return msg != null
        && typeof msg === "object"
        && msg.kind === APP_EVENT_POST_MESSAGE_KIND
        && typeof msg.data === "string";
}

export const SETUP_SESSION = Symbol("SETUP_SESSION");
export const SETUP_SESSION_URL = Symbol("SETUP_SESSION_URL");

export type SetupEventVariant =
    | VariantKind<typeof SETUP_SESSION, Uint8Array>  // Session ZIP bytes
    | VariantKind<typeof SETUP_SESSION_URL, string>  // Public dashql-session.json URL
    ;
