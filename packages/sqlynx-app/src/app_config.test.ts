import * as fs from 'fs/promises';
import { fileURLToPath } from 'node:url';

const configPath = new URL('../static/config.json', import.meta.url);

describe('App config', () => {
    it('can be parsed', async () => {
        const file = await fs.readFile(fileURLToPath(configPath), 'utf-8');
        expect(() => JSON.parse(file)).not.toThrow();
    });
    it('defines HyperApi artifacts', async () => {
        const file = await fs.readFile(fileURLToPath(configPath), 'utf-8');
        const config = JSON.parse(file);
        expect(config.connectors?.hyper?.hyperApi).toBeDefined();
    });
});
