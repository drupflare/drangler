/**
 * The published version, in one place.
 *
 * Read from `package.json` rather than restated, because the release workflow compares the compiled
 * binary against that file and a hand-maintained copy drifts silently until the release fails. Both
 * build modes inline a relative import, so the value is baked in rather than read at runtime.
 *
 * Its own module so `orientation()` can print it without importing the command tree that imports
 * `orientation()`.
 */
import pkg from '../package.json';

export const VERSION: string = pkg.version;
