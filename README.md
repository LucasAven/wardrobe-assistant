# Wardrobe assistant

Tells you what to wear, using your own clothes, your own body type, and the
rules from your own styling book.

Two front doors over one wardrobe:

- A **web app** you add to the iPhone home screen. Photograph a garment, the
  background comes off, and Claude fills in its type, warmth, formality and
  silhouette. Also where you review and correct those guesses.
- A **connector** you add to Claude once, so you can ask on your phone what to
  wear and it answers from the same wardrobe. That runs on your Claude
  subscription rather than per call.

## How it decides

Code filters, the model styles.

A hard constraint either distributes over single garments or it does not, and
that decides where it is enforced. Formality is `min(pieces) >= F`, which is
true exactly when every piece is `>= F`, so it can be applied one garment at a
time before the model sees anything. Same for rain and season. Warmth cannot,
because it sums across layers, so it is checked after the model answers and a
failing outfit is dropped rather than patched.

The result is that a too-casual outfit is not unlikely, it is unrepresentable.
The model only ever picks from garments that already passed.

Warmth is two bands, not one. `core` is the outfit without its coat, which is
what you sit in all day. `withOuter` is everything. They split on how long you
will be outside, so a cold day mostly indoors asks for a light shirt under a
warm coat instead of a heavy shirt.

## Setup

You need a Cloudflare account and an Anthropic API key. The free tier covers
this comfortably.

```bash
npm install
npx wrangler login
./scripts/setup.sh          # creates D1, R2 and KV, writes the ids, loads the schema
```

Then the three secrets it asks for at the end, and:

```bash
npx wrangler deploy
```

**One manual step the CLI cannot do.** Turn on Images for your account in the
Cloudflare dashboard. Background removal is an Images transform, so without it
every upload still works but keeps the original photo and skips the cutout.

## Day to day

```bash
npm test           # the engine, no network, no API key needed
npm run typecheck
npx wrangler dev   # local, though the Images binding wants --remote
```

## Layout

```
src/domain/     the engine. Pure, no network, no database.
  types.ts        the contract everything is written against
  bookRules.ts    your book, transcribed as predicates
  constraints.ts  every tunable number in the app lives here
  menu.ts         what the model is allowed to choose from
  certify.ts      the only thing that can mint a valid outfit
src/worker/     Cloudflare Worker. Routes, storage, vision tagging, auth.
src/db/         D1 schema.
public/         the web app. No build step.
docs/book/      the styling book, distilled. rules.md is loaded on every request.
```

`docs/` and `CONTEXT.md` are deliberately untracked.

## Where the book stops

The source is a 20 page guide covering one thing: classifying a male body as
rectangle, triangle, inverted triangle or circular, then balancing the
silhouette. It says nothing about formality, occasion, color palettes, fabric,
season, or fit details like shoulder seam and trouser break, and names those as
paid course content.

So the app labels where advice comes from. Book rules are cited by id. Weather
and formality are code. Anything else is the model's general knowledge, and it
says so.
