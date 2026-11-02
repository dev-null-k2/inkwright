/**
 * A short list of well-known remote MCP servers users can add with one tap. Every entry is the
 * provider's documented Streamable HTTP endpoint and was checked (Nov 2026) to answer MCP from a
 * browser origin: CORS allowed, and OAuth discovery + dynamic client registration reachable where
 * sign-in is OAuth. Servers that block browser clients (CORS) are deliberately not listed —
 * they can't work from a web app however they're configured.
 */
import type { McpAuthMethod } from './client.ts';

export interface KnownMcpServer {
  id: string;
  name: string;
  url: string;
  auth: McpAuthMethod;
  /** What it lets the assistant do, in one line. */
  blurb: string;
  /** The provider's documentation for this endpoint. */
  docs: string;
  /** For bearer-token servers: what token to paste and where to get it. */
  tokenHint?: string;
}

export const KNOWN_MCP_SERVERS: readonly KnownMcpServer[] = [
  {
    id: 'notion',
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    blurb: 'Search, read and create Notion pages and databases.',
    docs: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    blurb: 'Find, create and update Linear issues and projects.',
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    url: 'https://mcp.atlassian.com/v1/mcp',
    auth: 'oauth',
    blurb: 'Jira issues and Confluence pages.',
    docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
  },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'bearer',
    blurb: 'Issues, pull requests and repositories.',
    docs: 'https://github.com/github/github-mcp-server',
    tokenHint: 'A GitHub personal access token (github.com › Settings › Developer settings).',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    url: 'https://huggingface.co/mcp',
    auth: 'none',
    blurb: 'Search models, datasets, papers and Spaces.',
    docs: 'https://huggingface.co/docs/hub/hf-mcp-server',
  },
];
