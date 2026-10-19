import {createServer, type Server} from "node:http";

export interface OAuthLoopbackResult {
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
}

const LOOPBACK_HOSTS: Record<string, string> = {"localhost": "127.0.0.1", "127.0.0.1": "127.0.0.1", "[::1]": "::1"};
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/// Parse an OAuth redirect url that must point at a loopback port of this machine
export function parseLoopbackCallbackUrl(value: string): {host: string; port: number; pathname: string} {
    const url = new URL(value);
    const host = LOOPBACK_HOSTS[url.hostname];
    if (url.protocol !== "http:" || host === undefined || url.port === "") {
        throw new Error(`OAuth callback url must look like http://localhost:<port>/<path>, got ${value}`);
    }
    return {host, port: Number(url.port), pathname: url.pathname};
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function renderPage(result: OAuthLoopbackResult): string {
    const [title, message] = result.error === undefined
        ? ["Authentication Successful", "You can close this window and return to DashQL."]
        : ["Authentication Failed", result.errorDescription ?? result.error];
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>`
        + `<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:hsl(210deg,12%,16%);color:#eee}p{opacity:.7}</style>`
        + `</head><body><div><h1>${title}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

/// A one-shot http server that receives the authorization redirect of a loopback OAuth flow
export class OAuthLoopbackServer {
    readonly result: Promise<OAuthLoopbackResult>;
    #server: Server;
    #reject: (error: Error) => void = () => {};
    #timeout: NodeJS.Timeout;

    private constructor(server: Server, pathname: string, timeoutMs: number) {
        let resolve: (result: OAuthLoopbackResult) => void = () => {};
        this.result = new Promise<OAuthLoopbackResult>((res, rej) => {
            resolve = res;
            this.#reject = rej;
        });
        this.result.catch(() => {});
        this.#server = server;
        this.#server.on("request", (request, response) => {
            const url = new URL(request.url ?? "/", "http://localhost");
            if (url.pathname !== pathname) {
                response.writeHead(404).end();
                return;
            }
            const param = (name: string) => url.searchParams.get(name) ?? undefined;
            const result: OAuthLoopbackResult = {
                code: param("code"),
                state: param("state"),
                error: param("error") ?? (param("code") === undefined ? "missing_code" : undefined),
                errorDescription: param("error_description"),
            };
            response.writeHead(200, {"content-type": "text/html; charset=utf-8", "connection": "close"});
            response.end(renderPage(result), () => this.close());
            resolve(result);
        });
        this.#timeout = setTimeout(() => {
            this.#reject(new Error("Timed out waiting for the OAuth callback"));
            this.close();
        }, timeoutMs);
    }

    /// Start listening on the host and port of the callback url
    static async listen(callbackUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<OAuthLoopbackServer> {
        const target = parseLoopbackCallbackUrl(callbackUrl);
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
            server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE"
                ? new Error(`Port ${target.port} of the OAuth callback url is already in use`)
                : error));
            server.listen(target.port, target.host, () => resolve());
        });
        return new OAuthLoopbackServer(server, target.pathname, timeoutMs);
    }

    /// The port the server listens on
    get port(): number {
        const address = this.#server.address();
        return typeof address === "object" && address !== null ? address.port : 0;
    }

    /// Stop listening, rejecting the result if no callback arrived yet
    close(): void {
        clearTimeout(this.#timeout);
        this.#reject(new Error("OAuth callback server was closed"));
        this.#server.close();
        this.#server.closeIdleConnections();
    }
}
