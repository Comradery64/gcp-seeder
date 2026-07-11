import { createRequire } from 'node:module';

// Read the version from package.json at runtime. A static TS import would sit
// outside rootDir (./src); createRequire resolves relative to this module —
// ../package.json is the package root from both src/ (tsx) and dist/ (built).
const require = createRequire(import.meta.url);

/** The package version, sourced from package.json so release bumps stay in sync. */
export const VERSION: string = (require('../package.json') as { version: string }).version;
