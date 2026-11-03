/**
 * Where an MCP sign-in hands its result back to the app. Kept in a module of its own because the
 * redirect handler runs before the app starts (main.tsx), and importing these from ./mcp.ts would
 * pull the whole MCP client into the startup bundle.
 */
export const OAUTH_CHANNEL = 'inkwright-mcp-oauth';
export const OAUTH_CALLBACK_KEY = 'inkwright.mcp.oauth-callback';
