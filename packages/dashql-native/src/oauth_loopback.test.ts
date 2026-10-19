import {describe, expect, it} from "vitest";

import {OAuthLoopbackServer, parseLoopbackCallbackUrl} from "./oauth_loopback.js";

describe("OAuthLoopbackServer", () => {
    it("only accepts http urls with a loopback host and an explicit port", () => {
        expect(parseLoopbackCallbackUrl("http://localhost:56512/Callback")).toEqual({host: "127.0.0.1", port: 56512, pathname: "/Callback"});
        expect(parseLoopbackCallbackUrl("http://[::1]:8080/cb")).toEqual({host: "::1", port: 8080, pathname: "/cb"});
        expect(() => parseLoopbackCallbackUrl("https://localhost:56512/Callback")).toThrow();
        expect(() => parseLoopbackCallbackUrl("http://example.com:56512/Callback")).toThrow();
        expect(() => parseLoopbackCallbackUrl("http://localhost/Callback")).toThrow();
    });

    it("resolves with the authorization code of the redirect", async () => {
        const server = await OAuthLoopbackServer.listen("http://localhost:0/Callback");
        const ignored = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
        expect(ignored.status).toBe(404);
        const response = await fetch(`http://127.0.0.1:${server.port}/Callback?code=abc&state=xyz`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Authentication Successful");
        await expect(server.result).resolves.toEqual({code: "abc", state: "xyz", error: undefined, errorDescription: undefined});
    });

    it("forwards authorization errors", async () => {
        const server = await OAuthLoopbackServer.listen("http://localhost:0/Callback");
        const response = await fetch(`http://127.0.0.1:${server.port}/Callback?error=access_denied&error_description=%3Cnope%3E`);
        expect(await response.text()).toContain("&#60;nope&#62;");
        await expect(server.result).resolves.toMatchObject({error: "access_denied", errorDescription: "<nope>"});
    });

    it("rejects when closed before the redirect arrives", async () => {
        const server = await OAuthLoopbackServer.listen("http://localhost:0/Callback");
        server.close();
        await expect(server.result).rejects.toThrow("closed");
    });

    it("rejects when the port is taken", async () => {
        const server = await OAuthLoopbackServer.listen("http://localhost:0/Callback");
        await expect(OAuthLoopbackServer.listen(`http://localhost:${server.port}/Callback`)).rejects.toThrow("already in use");
        server.close();
    });
});
