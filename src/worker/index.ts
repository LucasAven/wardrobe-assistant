import { Hono } from 'hono';
import { login, requireSession } from './auth';
import type { Env } from './env';
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

app.route('/api/garments', garments);
app.route('/api/profile', profile);
app.route('/api/recommend', recommend);
app.route('/api/wear', wear);
app.get('/api/weather', currentWeather);

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

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
