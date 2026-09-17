# Wardrobe assistant

Tells you what to wear, using your own clothes, your own body type, and the
rules from your own styling book.

One wardrobe, two front doors. A **web app** you add to the iPhone home screen,
where you photograph a garment, the background comes off, and you review the
fields it was tagged with. And a **connector** you add to Claude once, so you can
ask on your phone what to wear and get an answer built from the same catalog.

## The model runs on a subscription, not on an API key

The usual way to put a model in an app is an API key and a per-token bill that
grows every time anyone uses it. I did not want a side project that charges me
for looking at it, so the model is not a dependency of this app. It is a client
of it.

The Worker exposes an MCP server on `/mcp`, and you add that to Claude as a
custom connector. From then on Claude is the thing calling the app rather than
the other way round, so the inference happens inside your own Claude session and
is billed to the subscription you already pay for. The app itself spends nothing
per question, and there is no key to rotate, leak, or budget.

The trade is that the app has to hand over a problem small enough to be worth
handing over. So the Worker does every part of the decision a computer can do,
and `plan_outfit` returns the result: the body type and the mirror observations
behind it, the book rules for that body, both warmth bands, the formality floor,
the season, the rain, and a per-slot menu of garments that already passed all of
it. Claude picks from that menu and explains the pick. `save_outfit` then
re-certifies the answer against the exact menu that plan minted, so a wrong
answer is rejected rather than stored.

Seven tools. `wardrobe_status` to get oriented, `next_untagged` and
`set_garment_tags` to describe a photographed garment, `plan_outfit` and
`save_outfit` to build one, `past_outfits` to read back what you wore, and
`log_wear` to feed the recency cooldown.

Auth is OAuth, because Claude drives that flow itself and offers no field to
paste a shared token into. `@cloudflare/workers-oauth-provider` wraps the Worker
and keeps its state in KV. There is one user and one password, and the consent
screen checks the same password the web app does.

**About `ANTHROPIC_API_KEY`.** There is still one, and it is optional. It buys
the vision pass that fills in a garment's fields right after you photograph it,
which the connector does instead with `next_untagged` and `set_garment_tags`. The
only other thing that reads it is `POST /api/recommend`, a leftover from before
the connector existed that nothing in the web app calls any more. Leave it unset
and every screen still works.

## How it decides

Code filters, the model styles.

A hard constraint either distributes over single garments or it does not, and
that decides where it is enforced. Formality is `min(pieces) >= F`, which is
true exactly when every piece is `>= F`, so it can be applied one garment at a
time before the model sees anything. Same for season. Warmth cannot, because it
sums across layers, so it is checked after the model answers and a failing
outfit is dropped rather than patched.

The result is that a too-casual outfit is not unlikely, it is unrepresentable.
The model only ever picks from garments that already passed.

Rain used to be a filter here and is not any more. It distributes perfectly
well, so the shape was right and the answer was still wrong: a wardrobe with no
waterproof shoes lost the whole shoes slot on a wet day, and shoes are required,
so no outfit existed at all. The weather still reaches the model, which can pick
the boots on its own. A filter has to be one the wardrobe can always satisfy.

Warmth is two bands, not one. `core` is the outfit without its coat, which is
what you sit in all day. `withOuter` is everything. They split on how long you
will be outside, so a cold day mostly indoors asks for a light shirt under a
warm coat instead of a heavy shirt.

## Setup

You need a Cloudflare account. The free tier covers this comfortably, and no API
key is required.

```bash
npm install
npx wrangler login
./scripts/setup.sh          # creates D1, R2 and KV, writes the ids, runs the migrations
```

Then set the two secrets it prints at the end, copy `.env.example` to `.dev.vars`
for local development, and:

```bash
npx wrangler deploy
```

**One manual step the CLI cannot do.** Turn on Images for your account in the
Cloudflare dashboard. Background removal is an Images transform, so without it
every upload still works but keeps the original photo and skips the cutout.

Last, add the connector in Claude pointing at `https://<your-worker>/mcp` and
sign in with the password you just set.

## Day to day

```bash
npm test           # 438 vitest tests and 84 selftests. No network, no key needed
npm run typecheck
npm run db:migrate # applies any new migration to the local database
npx wrangler dev   # local, though the Images binding wants --remote
```

The database is defined by `src/db/migrations/*.sql`, applied in filename order
and each one exactly once. `scripts/migrate.sh` records what it applied in a
`_migration` table, so it is safe to run again and it skips what is already
there. To change the schema, add the next numbered file. Never edit a migration
that has already run somewhere.

```bash
./scripts/migrate.sh --remote   # the deployed database
```

## Layout

```
src/domain/     the engine. Pure, no network, no database, no model.
  types.ts        the contract everything is written against
  bookRules.ts    the book, transcribed as predicates that carry their own reason
  constraints.ts  every tunable number in the app lives here
  menu.ts         what the model is allowed to choose from
  certify.ts      the only thing that can mint a valid outfit
src/worker/     Cloudflare Worker. Routes, storage, auth, and the MCP server.
src/db/         D1 migrations, in order. The schema is their sum.
public/         the web app. No build step.
```

`public/` is plain ES modules the browser loads exactly as written, so there is
no bundler, no framework, and nothing to keep in step with a build.

## Honest limits

It has one user, by design. The season table is Buenos Aires, so July is winter
and a northern hemisphere wardrobe would get the wrong half of the year. One
password covers both front doors.

The styling source is a 20 page guide covering one thing: classifying a male
body as rectangle, triangle, inverted triangle or circular, then balancing the
silhouette. It says nothing about formality, occasion, color palettes, fabric,
season, or fit details like shoulder seam and trouser break, and names those as
paid course content.

So the app labels where advice comes from. Book rules are cited by id. Weather
and formality are code. Anything else is the model's general knowledge, and it
says so.

The guide itself is not in this repo. `src/domain/bookRules.ts` is my own
transcription of its rules into predicates I can test.
