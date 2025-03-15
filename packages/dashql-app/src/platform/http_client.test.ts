import '@jest/globals';

describe('Http Client', () => {
    it("Request.arrayBuffer equals manual UTF-8 encoding", async () => {
        const urlParams = new URLSearchParams();
        urlParams.set("grant_type", "authorization_code");
        urlParams.set("code", "foo");
        urlParams.set("redirect_uri", "http://localhost:9002/oauth.html");
        const request = new Request("http://localhost:9003", {
            method: 'POST',
            headers: new Headers({
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            }),
            body: urlParams,
        });
        const buffer = await request.arrayBuffer();

        const body = (new URLSearchParams(urlParams)).toString();
        const manualUTF8 = (new TextEncoder()).encode(body);

        expect(buffer.byteLength).toEqual(94);
        expect(buffer.byteLength).toEqual(manualUTF8.byteLength);
        expect(new Uint8Array(buffer)).toEqual(manualUTF8);
    });
});
