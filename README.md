# OpenTV — backend

The social layer for [OpenTV](https://github.com/mahmoodbashar08/opentv-app): a
privacy-first TV & movie tracker that runs entirely on-device.

**The app's code is in [opentv-app](https://github.com/mahmoodbashar08/opentv-app).**

**This server is a convenience layer, not a dependency.** The phone's SQLite
database is the source of truth for a user's own library. If this server
disappeared, every user would keep their complete watch history and the app
would keep working — they would lose other people's comments and ratings, and
nothing else. There is no watch-history table here, by design.

Users who decline the community never contact this server at all.

## Run your own

One container, one directory, no database server and no reverse proxy — the
data is a SQLite file because D1 *is* SQLite, and the only bytes stored are
pictures and the opt-in backup ZIPs, so they are folders.

```bash
echo "SESSION_SECRET=$(openssl rand -base64 48)" > .env
docker compose up -d
curl http://localhost:8787/v1/links      # {"links":[]}
```

Then point the app at it: **Settings → Your data → Community server**. Changing
that address signs the device out of the community — a token belongs to the
server that issued it — and leaves the local library alone.

[`SELF-HOSTING.md`](SELF-HOSTING.md) has the rest: backups, HTTPS, what an
instance without Workers AI or edge caching does instead (it says so, rather
than failing), and how to move between instances.

## Stack

- **Cloudflare Workers** + **Hono** — scales to zero, free until ~67,000 installs
- **D1** (SQLite) — the same engine the app uses on-device
- **R2** — avatars now, comment images later (behind CSAM scanning)

## Start

```bash
npm install
wrangler d1 create opentv          # put the id in wrangler.jsonc
npm run db:local                   # apply migrations locally
npm run dev
```

## OpenTV Plus

`POST /v1/rc/webhook` is the only thing that may grant Plus — a client that
could set it would make Plus free within a week. RevenueCat authenticates with
a shared string in the `Authorization` header:

```bash
wrangler secret put RC_WEBHOOK_SECRET   # same value in RevenueCat → Integrations → Webhooks
```

Unset means the route answers 503: no secret, no webhook. Grants on
INITIAL_PURCHASE / RENEWAL / UNCANCELLATION / PRODUCT_CHANGE /
NON_RENEWING_PURCHASE naming the `plus` entitlement; revokes on EXPIRATION
alone, because CANCELLATION only means auto-renew is off and the period is
still paid for. Free profiles publish at most 10 lists and 20 favourites per
kind, enforced in `routes/published.ts` and grandfathered so a set published
before Plus existed is never shrunk.

The one other writer is `POST /v1/me/free-month` (2.0.3): every account may
take thirty days of Plus once, written into `plus_until` like a gift, added to
the end of any grant still running and refused to a paying subscriber. To stop
delete-and-sign-in-again, it keeps `free_month_claims`: an HMAC of each
sign-in's provider subject, so it can answer "has this sign-in had its month?"
and cannot be turned back into an address or an id. It survives account
deletion because that is its only job. `profiles.heard_from` is the optional
sign-up question, one of five channel names and never free text.

## Read before changing anything

- [`docs/PLAN.md`](docs/PLAN.md) — decisions, reasoning, build order, blockers
- [`docs/schema.dbml`](docs/schema.dbml) — the database (open the DBML preview)
- [`docs/data-layer.md`](docs/data-layer.md) — the same design, in prose

## Licence

[AGPL-3.0](LICENSE). Run it, change it, host it for your friends. If you run a
modified version as a service, the same licence asks you to publish your
changes — which is the only condition here, and it is the one that keeps this
the kind of thing it is.

The app is separate and more permissive:
[MPL-2.0](https://github.com/mahmoodbashar08/opentv-app).

Copyright (C) 2026 Mahmood Bashar. See [NOTICE](NOTICE).

## Helping

If you run this and it is useful, [here is what actually helps](https://theopentv.com/sponsor).
There is no donation channel yet — the honest reasons are on that page — so the
list is a star, a store review, and a bug report.
