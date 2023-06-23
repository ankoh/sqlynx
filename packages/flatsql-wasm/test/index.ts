import * as flatsql from '../lib';
import path from 'path';
import fs from 'fs';

// Loading debug symbols, especially for WASM take insanely long so we just disable the test timeout
jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

beforeAll(async () => {});

afterAll(async () => {});
