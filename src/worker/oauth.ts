/**
 * The consent screen. Claude drives OAuth itself and offers no shared-token
 * field, so this is the only way the connector can be attached at all.
 *
 * There is one user and one password. The screen checks the same
 * `APP_PASSWORD` the web app's login checks, through the same constant-time
 * comparison, so a deployment has one secret and not two.
 */

import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';
import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import type { Context, Handler } from 'hono';
import { z } from 'zod';
import { missingConfig, passwordMatches } from './auth';
import type { SecretName } from './auth';
import type { Env } from './env';

type Ctx = Context<{ Bindings: Env }>;

/** Same pair the web app's login gate needs, and for the same reason. */
const PASSWORD_GATE = ['APP_PASSWORD', 'SESSION_SECRET'] as const satisfies readonly SecretName[];

/**
 * One person owns this wardrobe. The id still exists because every grant, every
 * token and every stored plan is keyed by it.
 */
const OWNER = 'owner';

const escapes: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** The client name comes from whoever registered the client, so it is not ours to trust. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escapes[character] ?? character);
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #f6f5f3; color: #1c1b19; padding: 24px; }
  main { width: 100%; max-width: 26rem; background: #fff; border-radius: 16px;
         padding: 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.12); box-sizing: border-box; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: #4b4945; }
  ul { margin: 0 0 20px; padding-left: 1.1rem; color: #4b4945; }
  li { margin-bottom: 4px; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 12px; font-size: 16px;
          border: 1px solid #ccc8c2; border-radius: 10px; background: #fff; color: inherit; }
  button { width: 100%; margin-top: 16px; padding: 13px; font-size: 16px; font-weight: 600;
           border: 0; border-radius: 10px; background: #1c1b19; color: #fff; cursor: pointer; }
  .error { color: #a3231a; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    body { background: #161513; color: #f2f0ed; }
    main { background: #232120; box-shadow: none; }
    p, ul { color: #b8b3ac; }
    input { background: #161513; border-color: #3b3835; }
    button { background: #f2f0ed; color: #161513; }
  }
`;

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function consentPage(client: ClientInfo, wrongPassword: boolean): Response {
  const name = escapeHtml(client.clientName ?? 'An application');
  const warning = wrongPassword ? '<p class="error">That is not the password.</p>' : '';

  return page(
    'Connect to your wardrobe',
    `<h1>Connect ${name}</h1>
     <p>${name} is asking to reach this wardrobe. If you did not start this, close the page.</p>
     <ul>
       <li>read your garments, their photos and your body profile</li>
       <li>write the description of a garment you have not tagged yet</li>
       <li>save an outfit and record what you wore</li>
     </ul>
     ${warning}
     <form method="post">
       <label for="password">Wardrobe password</label>
       <input id="password" name="password" type="password" autocomplete="current-password"
              autofocus required>
       <button type="submit">Connect</button>
     </form>`,
    wrongPassword ? 401 : 200,
  );
}

/**
 * An unknown client or a bad redirect has nowhere safe to be sent, so it is
 * shown here. Everything else goes back to the client as an OAuth error, which
 * is what the spec asks for and what lets Claude report something useful.
 */
function authorizationErrorResponse(error: AuthorizationError): Response {
  if (error.redirectUri === undefined) {
    return page(
      'Cannot connect',
      `<h1>Cannot connect</h1><p>${escapeHtml(error.description)}</p>`,
      400,
    );
  }

  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set('error', error.code);
  redirect.searchParams.set('error_description', error.description);
  if (error.state !== undefined) redirect.searchParams.set('state', error.state);
  if (error.issuer !== undefined) redirect.searchParams.set('iss', error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

interface Parsed {
  readonly request: AuthRequest;
  readonly client: ClientInfo;
}

async function parse(c: Ctx): Promise<Parsed | Response> {
  let request: AuthRequest;
  try {
    request = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(request.clientId);
  if (client === null) {
    return page(
      'Cannot connect',
      '<h1>Cannot connect</h1><p>That application is not registered with this wardrobe.</p>',
      400,
    );
  }
  return { request, client };
}

export const authorizePage: Handler<{ Bindings: Env }> = async (c) => {
  const fault = missingConfig(c.env, PASSWORD_GATE);
  if (fault !== null) return c.json(fault, 503);

  const parsed = await parse(c);
  if (parsed instanceof Response) return parsed;
  return consentPage(parsed.client, false);
};

const ApprovalSchema = z.object({ password: z.string() });

export const approveAuthorization: Handler<{ Bindings: Env }> = async (c) => {
  const fault = missingConfig(c.env, PASSWORD_GATE);
  if (fault !== null) return c.json(fault, 503);

  const parsed = await parse(c);
  if (parsed instanceof Response) return parsed;

  const form = ApprovalSchema.safeParse(Object.fromEntries(await c.req.raw.formData()));
  if (!form.success || !(await passwordMatches(c.env, form.data.password))) {
    return consentPage(parsed.client, true);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: parsed.request,
    userId: OWNER,
    metadata: { clientName: parsed.client.clientName ?? null },
    // Whatever the client asked for. There is one user with one wardrobe, so a
    // narrower grant would only be a second thing to keep in step.
    scope: parsed.request.scope,
    props: { userId: OWNER },
  });

  return c.redirect(redirectTo, 302);
};
