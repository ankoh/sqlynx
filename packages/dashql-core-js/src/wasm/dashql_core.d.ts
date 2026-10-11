import type { DashQLModuleOptions, EmscriptenModule } from '../api.js';

export default function createDashQLModule(options?: DashQLModuleOptions): Promise<EmscriptenModule>;
