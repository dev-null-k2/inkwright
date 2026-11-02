// `node --import ./scripts/raw-hooks.mjs` (or `tsx --import …`): lets the source tree load
// `?raw` imports. See raw-loader.mjs.
import { register } from 'node:module';

register('./raw-loader.mjs', import.meta.url);
