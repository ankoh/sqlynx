export const MAX_DEEP_LINK_DATA_LENGTH = 64 * 1024;

export type DeepLink =
    | {type: "event", value: string}
    | {type: "session", value: string};

export function parseDeepLink(link: string): DeepLink | null {
    if (link.length > MAX_DEEP_LINK_DATA_LENGTH * 3) return null;

    let url: URL;
    try {
        url = new URL(link);
    } catch {
        return null;
    }
    const isDashQLLink = url.protocol === "dashql:" && url.hostname === "localhost" && url.port === "";
    const isProductionLink = url.protocol === "https:" && url.hostname === "dashql.app" && url.port === "";
    const isDevelopmentLink = url.protocol === "http:" && url.hostname === "localhost" && url.port === "9002";
    if ((!isDashQLLink && !isProductionLink && !isDevelopmentLink) || url.username !== "" ||
        url.password !== "" || (url.pathname !== "" && url.pathname !== "/") || url.hash !== "") {
        return null;
    }

    const parameters = [...url.searchParams.entries()];
    if (parameters.length !== 1) return null;
    const [name, value] = parameters[0];
    if ((name !== "data" && name !== "session") || value.length === 0 || value.length > MAX_DEEP_LINK_DATA_LENGTH) {
        return null;
    }
    return {type: name === "data" ? "event" : "session", value};
}

export function parseDeepLinksFromCommandLine(commandLine: readonly string[]): DeepLink[] {
    const links: DeepLink[] = [];
    for (const argument of commandLine) {
        const data = parseDeepLink(argument);
        if (data !== null) links.push(data);
    }
    return links;
}

export class DeepLinkQueue {
    private readonly pending: DeepLink[] = [];
    private receiver: ((data: DeepLink) => void) | null = null;

    push(data: DeepLink): void {
        if (this.receiver === null) this.pending.push(data);
        else this.receiver(data);
    }

    attach(receiver: (data: DeepLink) => void): DeepLink[] {
        this.receiver = receiver;
        return this.pending.splice(0);
    }

    detach(): void {
        this.receiver = null;
    }
}
