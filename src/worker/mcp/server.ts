/**
 * The remote MCP endpoint, on one `/mcp` route over Streamable HTTP.
 *
 * Stateless: a fresh `McpServer` per request, built by the factory
 * `createMcpHandler` calls. Nothing is held between calls, so no Durable Object
 * is involved and a plan survives from one call to the next only because it was
 * written to KV.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from '../env';
import { wardrobeTools } from './tools';
import type { ToolContext } from './tools';

const SERVER_INFO = {
  name: 'wardrobe',
  title: 'Wardrobe',
  version: '1.0.0',
} as const;

const INSTRUCTIONS = `One person's wardrobe: their photographed clothes, their body type, and the rules of the men's styling guide they own.

Two jobs live here.

Cataloguing. A photo uploaded from the web app arrives with no description. next_untagged shows you one, you look at it, set_garment_tags writes what you saw. An untagged garment cannot appear in any outfit, so this comes first.

Dressing. plan_outfit does everything a computer can decide about today: the weather, the warmth bands, the formality floor, the season, the recency cooldown, and the guide's outright donts. It hands back a menu of garments that already pass all of it. You choose from that menu, which is the part no filter can do, and save_outfit checks the result and stores it. log_wear records what was actually put on, which is the only thing that keeps the same coat from coming back every day.

Call wardrobe_status first when you are not sure what state any of this is in.

Provenance matters here and is the reason the app exists. A claim only speaks for the guide when you cite the id of the rule it came from. Warmth, formality, season and rain are the app's arithmetic. Everything else is your own taste, which is wanted, and should read as yours.`;

/** The token props the consent screen puts on every grant. */
interface Principal {
  readonly userId: string;
}

function principalFrom(props: unknown): Principal {
  const userId = (props as { readonly userId?: unknown } | null)?.userId;
  // The provider only reaches this handler with a grant it decrypted itself, so
  // a missing id means a grant issued before the consent screen set one.
  return { userId: typeof userId === 'string' && userId !== '' ? userId : 'owner' };
}

function build(context: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const tool of wardrobeTools(context)) tool.register(server);
  return server;
}

export const mcp = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const context: ToolContext = {
      env,
      userId: principalFrom(ctx.props).userId,
      origin: new URL(request.url).origin,
      now: () => new Date(),
    };
    return createMcpHandler(() => build(context), { route: '/mcp' })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
