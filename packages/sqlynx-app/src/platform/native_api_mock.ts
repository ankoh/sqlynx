import { PlatformType } from "./platform_api.js";

/// Only process requests that are targeting sqlynx-native://
const NATIVE_API_SCHEME = "sqlynx-native://";

/// The native API mock mimics the api that is provided by tauri.
export class NativeAPIMock {
    platform: PlatformType;

    /// The constructor
    constructor(platform: PlatformType) {
        this.platform = platform;
    }

    /// Process a fetch request.
    /// This mock will reject any request that are not targeting the native api.
    public async process(req: Request): Promise<Response> {
        // Reject any requests that are not targeting native
        if (!req.url.startsWith(NATIVE_API_SCHEME)) {
            return new Response(null, {
                status: 400,
                statusText: `scheme is not matching ${NATIVE_API_SCHEME}`,
                headers: {}
            });
        }

        let url = new URL(req.url);
        if (url.pathname == "/") {
            return new Response(null, {
                status: 200,
                statusText: "OK",
                headers: {}
            });
        }

        return new Response(null, {
            status: 400,
            statusText: "unknown request path",
            headers: {}
        })
    }
}
