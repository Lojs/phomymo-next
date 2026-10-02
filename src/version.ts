/**
 * The running version, injected at build time from package.json (see vite.config.ts).
 * Bumping package.json is therefore the only step a release needs — the About
 * dialog always shows the version that was actually built.
 *
 * Always displayed in English, even in the Arabic UI: a version number is not a
 * word, so it must not be reordered by RTL bidi.
 */
export const APP_VERSION = import.meta.env.APP_VERSION as string;