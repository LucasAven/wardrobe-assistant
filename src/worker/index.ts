import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { login, requireSession } from './auth';
import type { Env } from './env';
import { mcp } from './mcp/server';
import { approveAuthorization, authorizePage } from './oauth';
import { MAX_OUTFITS, recentOutfits, todayOutfit } from './outfits';
import { cutKey, origKey } from './photos';
import { garments } from './routes/garments';
import { profile } from './routes/profile';
import { currentWeather, recommend } from './routes/recommend';
import { wear } from './routes/wear';

const app = new Hono<{ Bindings: Env }>();

// Registration order is what leaves login open: Hono runs matching handlers in
// the order they were added, so this one answers before the guard below is
// reached.
app.post('/api/login', login);
app.use('/api/*', requireSession);
app.use('/img/*', requireSession);

app.get('/authorize', authorizePage);
app.post('/authorize', approveAuthorization);

app.route('/api/garments', garments);
app.route('/api/profile', profile);
app.route('/api/recommend', recommend);
app.route('/api/wear', wear);
app.get('/api/weather', currentWeather);

/**
 * `null` rather than a 404: nothing saved today is a normal state the app has a
 * screen for, and a 404 would read as a broken request instead.
 */
app.get('/api/outfits/today', async (c) => {
  return c.json({ outfit: await todayOutfit(c.env.DB, new Date()) });
});

app.get('/api/outfits', async (c) => {
  const asked = Number(c.req.query('limit') ?? MAX_OUTFITS);
  const limit = Number.isFinite(asked) && asked > 0 ? asked : MAX_OUTFITS;
  return c.json({ outfits: await recentOutfits(c.env.DB, limit) });
});

app.get('/img/:kind/:id', async (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'orig' && kind !== 'cut') return c.notFound();

  const id = c.req.param('id');
  const object = await c.env.PHOTOS.get(kind === 'cut' ? cutKey(id) : origKey(id));
  if (object === null) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // private, not public: this route needs the session cookie, so a shared
  // cache holding the response would serve one person's wardrobe to another.
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(object.body, { headers });
});

/**
 * `not_found_handling: "single-page-application"` answers every unknown path
 * with index.html and a 200, so a connector pointed at the wrong path gets the
 * web app instead of an error and reads as working. `/sse` is the path someone
 * reaches for when a server speaks the older MCP transport, so name the right
 * one rather than serving a page.
 */
app.all('/sse', (c) =>
  c.json(
    {
      error: 'This server speaks MCP over Streamable HTTP, not SSE.',
      endpoint: new URL('/mcp', c.req.url).toString(),
    },
    404,
  ),
);

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * The Hono app is the default handler, so the web app and its cookie session
 * are untouched by any of this. Only `/mcp` sits behind an access token, which
 * is what Claude's connector negotiates for itself.
 */
const oauth = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: mcp,
  defaultHandler: app,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
});

export default {
  // `ctx` is optional because the runtime always supplies one and a caller
  // driving `fetch` by hand does not. The provider reads it only on the `/mcp`
  // path, which needs a token no such caller has.
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    return oauth.fetch(request, env, ctx as ExecutionContext);
  },
};
