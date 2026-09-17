# Domain model

What the app stores and why it is shaped that way. `README.md` covers how a
decision gets made, this covers what the decision is made out of.

## The decision the system makes

Given a wardrobe and a moment (weather, event, time of day, how long you will be
outside, mood), return a complete outfit justified by rules from a styling book
applied to this specific body. One outfit by default. `plan_outfit` takes an
`optionsWanted` count when the owner explicitly asks to choose between a few, and
every option is then composed against that one plan.

The split that makes this work: **code does the objective filtering, the model
does the subjective styling.** Code narrows the wardrobe to the garments that are
physically appropriate, meaning warm enough, formal enough, in season, and clear
of the book's outright donts. The model then composes and explains. Nothing about
proportion or color harmony is hardcoded, and nothing about temperature is left
to vibes.

## Slots

An outfit is a set of filled slots, not a free-form bag of clothes. The slot is
the organizing structure. Every rule about layering, formality and proportion
keys off it.

| Slot | Required | Examples |
|---|---|---|
| `base` | yes | t-shirt, tank, thermal |
| `top` | no | oxford shirt, polo, knit |
| `mid` | no | cardigan, overshirt, vest, blazer |
| `outer` | no | jacket, coat, parka |
| `bottom` | yes | jeans, chinos, shorts, trousers |
| `shoes` | yes | sneakers, boots, loafers |
| `accessory` | no, repeatable | belt, cap, scarf, watch, bag |

`base` alone is a valid warm-weather outfit. `base` plus `top` is a layered one.
The chain matters for warmth, which sums, and for formality, which does not.

## Garment

The record behind every photo. Written by whoever tags the garment, which is
normally the connector through `next_untagged` and `set_garment_tags`, then
editable by hand on the Review screen when it gets something wrong.

- `id`, `slot`, `subtype` (free text: "chelsea boot")
- `image_original`, `image_cutout` (R2 keys)
- `colors`: ordered list, plus `color_role` of `neutral` or `accent`
- `pattern`: solid, stripe, check, print
- `fabric`: cotton, wool, linen, denim, leather, synthetic
- `warmth`: 0 to 5. Sums across worn layers, compared against a temperature
  band. A number rather than a category because layering is additive.
- `formality`: 1 to 5, gym to black tie. Does not sum. An outfit's formality is
  its lowest piece, which is why one wrong shoe ruins a look.
- `fit`: slim, regular, relaxed, oversized
- `rise` (bottoms) and `hem` (tops). Where the waist sits and where the top ends
  is what every proportion rule in the book actually keys on.
- `structured`: bool. The garment holds its own shape off the body, a blazer or
  a denim jacket rather than a tee or a hoodie. Read off the photo and never
  asked about, because two book rules need it and the owner does not want the
  question.
- `seasons`, `notes`

## Body profile

One record, filled once, and it holds no measurements. The book classifies by
visual comparison in a mirror rather than by centimeters, so the profile stores
the five comparisons it asks for and nothing else:

- `shouldersVsHips`: wider, narrower, or equal
- `waistIsWidest`: is the waist the widest point of the body
- `volume`: where the body carries it, top, bottom, center or even
- `line`: straight or curved
- `thinLegs`: bool

`bodyType` is derived from those, one of `rectangle`, `triangle`,
`inverted_triangle` or `circular`. Only the first three fields classify.
`line` describes the rectangle rather than finding it, and `thinLegs` only
hardens one inverted triangle rule. `src/domain/bodyType.ts` does the derivation
and returns the sentence naming which observations decided it, which is what the
profile screen shows back.

## Style rules

The book is not loaded at runtime and is not in this repo. Its rules are
transcribed into `src/domain/bookRules.ts` as predicates, each one carrying the
id and the reason from the line it came from. `plan_outfit` sends only the rules
for the derived body type, so the model never sees the other three types' rules.

A rule is a hard filter only when no other garment can change its verdict.
`bottom` and `outer` are always on show, so a rule about them filters the menu.
`base`, `top` and `mid` can be covered by a layer, so a rule about how one of
them looks is checked against the assembled outfit in `certify.ts` instead.

## Wear log

`{id, worn_on, garment_ids, event, weather, accepted}`. One purpose: stop it
suggesting the same jacket four days running, and record which suggestions
actually got worn. The per-slot cooldown lengths live in `constraints.ts`, and
accessories have a cooldown of zero, because wearing the same watch every day is
correct rather than repetition to avoid.

## Storage

D1 for garments, profile, outfits and the wear log. R2 for images, both the
original and the cutout. D1 rather than a JSON blob in R2 because two writers
exist, the web app and the connector, and a read-modify-write on a shared blob
races. SQLite removes the sharing rather than serializing it.

KV holds two things, the OAuth grants and tokens the connector negotiates, and
the plan `plan_outfit` minted, under a one hour TTL so `save_outfit` can certify
against the exact menu it was given rather than a rebuilt one.
