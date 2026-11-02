/**
 * `@inkstone/plugin-api` — everything a plugin author (and the app that hosts plugins) shares:
 *
 * - `api.ts`: the `InkstoneAPI` plugins call, `definePlugin`, and the payload types;
 * - `manifest.ts`: the manifest.json schema, validation and version comparison;
 * - `permissions.ts`: the permission list, note scopes and the network allowlist;
 * - `protocol.ts`: the versioned postMessage protocol and the method → permission table;
 * - `client.ts`: the plugin side of the protocol over any transport.
 *
 * See docs/PLUGINS.md.
 */
export * from './api.ts';
export * from './manifest.ts';
export * from './permissions.ts';
export * from './protocol.ts';
export * from './client.ts';
