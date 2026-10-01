# Curation guide

Markets are created permissionlessly — anyone who can call the factory gets a `Market` row in
this indexer. Curation is the allowlist that decides which of them reach the frontend, plus the
metadata that describes each vault and the yield protocol behind it.

Three things are curated:

| What | Gates visibility? | Set by |
|---|---|---|
| **Market listing** (`Market.listed`) | **Yes** — nothing shows until approved | you, per market |
| **Vault metadata** (display name, copy, which protocol) | No — purely descriptive | you, per vault |
| **Protocol metadata** (name, logo, links) | No — purely descriptive | you, once per protocol |

A protocol deploys one vault per asset it supports (Blend has an XLM vault and a USDC vault), so
the protocol's details live in a `Protocol` row that every one of its vaults points at. Fill them
in once; every vault on that protocol picks them up.

Metadata never blocks a market from listing. A market whose vault or protocol is unfilled will
render with the frontend's own fallbacks, so fill both in before approving its markets.

---

## Setup

Curation needs `ADMIN_API_KEYS` set on the API process: one credential per curator, as
`name=secret`, comma-separated. The name is recorded as `curatedBy` on every listing and
metadata change, so a decision can be traced to the person who made it. **If it is unset,
every `/admin` route returns 503** — the admin surface fails closed rather than open.

```bash
openssl rand -hex 32     # one per curator; .env: ADMIN_API_KEYS="alice=<hex>,bob=<hex>"
```

The older single `ADMIN_API_KEY` still works and is recorded as the curator `admin`; split it
into named keys before more than one person curates. The CLI (`npm run curate`) records the
operating-system user name, or `CURATOR` from the environment.

The CLI talks to Postgres directly and needs only `DATABASE_URL`, so it works even when the API
is down.

---

## Two ways to do it

Both go through the same code path (`setListed` / `setVaultMetadata` / `setProtocolMetadata` in
`src/curation.ts`), so they cannot drift.

- **CLI** — `npm run curate -- …`, run on the box. No secret in play beyond the DB URL.
- **HTTP** — `PATCH /admin/…` with an `X-Admin-Key` header. For remote use or a future admin UI.

---

## Curating markets

### Review what's waiting

```bash
npm run curate -- pending      # unlisted markets awaiting review
npm run curate -- listed       # markets currently live on the frontend
```

`pending` includes matured markets — something can mature while still sitting unreviewed.

### Approve or hide

```bash
npm run curate -- approve CVAULT...:1790000000 "vetted, Blend XLM vault"
npm run curate -- hide    CVAULT...:1790000000 "suspected spoof of the XLM market"
```

The trailing note is optional and stored in `Market.curationNote`, beside `curatedBy`. **Both
are internal** — the public serializer strips them from every response. Write freely.

The market id is the composite `` `${vault}:${maturity}` ``, exactly as `pending` prints it.

### Over HTTP

```bash
curl -X PATCH "$API/admin/markets/CVAULT...:1790000000" \
  -H "X-Admin-Key: $MY_CURATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"listed": true, "note": "vetted, Blend XLM vault"}'
```

`GET /admin/markets` returns the full review queue (newest first, expired included).
`?listed=false` narrows it to what still needs a decision.

---

## Curating protocols

A protocol is the thing a vault lends into: Blend, XOXNO. Its row carries the name, logo and
links the market details page renders, and every vault on that protocol shares them.

### The id is a slug you choose

```bash
npm run curate -- protocol-add blendv2 "Blend Capital"
npm run curate -- protocol-add xoxno "XOXNO"
```

Lowercase letters, digits and dashes, up to 40 characters. **Version the slug where the protocol
is versioned**: the vaults deployed so far lend into Blend v2, so the slug is `blendv2`. When
Blend v3 ships, add `blendv3` as its own protocol rather than editing `blendv2` — old vaults keep
pointing at what they actually lend into, and the two can carry different audit links.

The slug is typed on the command line and appears in admin URLs, and there is no rename. Pick it
once.

### See what needs filling

```bash
npm run curate -- protocols          # every protocol, flagged complete / incomplete
npm run curate -- protocol blendv2   # one protocol, every field, plus its vaults
```

### Fill a field

```bash
npm run curate -- protocol-set blendv2 logoUrl "/BLND.png"
npm run curate -- protocol-set blendv2 website "https://blend.capital"
npm run curate -- protocol-set blendv2 docsUrl "https://docs.blend.capital"
```

Over HTTP, `POST /admin/protocols` creates and `PATCH /admin/protocols/:id` updates. A `PATCH`
against a slug that does not exist is a 404, never a silent create — a typo cannot spawn a
second protocol.

```bash
curl -X POST "$API/admin/protocols" \
  -H "X-Admin-Key: $MY_CURATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "id": "blendv2",
        "name": "Blend Capital",
        "website": "https://blend.capital",
        "logoUrl": "/BLND.png",
        "note": "audit reviewed 2026-08-30"
      }'
```

### The fields

| Field | Max | Example |
|---|---|---|
| `name` | 500 | `Blend Capital` — required, cannot be cleared |
| `logoUrl` | 500 | `/BLND.png` — a path into `frontend/public`, or an https URL |
| `website` | 500 | `https://blend.capital` |
| `docsUrl` | 500 | `https://docs.blend.capital` |
| `auditUrl` | 500 | `https://.../audit.pdf` |

The three link fields must be **https** URLs and the logo must be a clean `/path` or https. The
details page renders these straight into `href` and `<Image src>`, so a stolen admin key must not
be able to plant a `javascript:` or phishing link there. `http:`, protocol-relative `//host`, and
`..` path segments are all rejected.

---

## Curating vaults

A vault is one deployment of a protocol for one asset. Its own metadata is what is specific to
that deployment; the protocol details come from the row it points at.

### See what needs filling

```bash
npm run curate -- vaults           # every vault, flagged complete / incomplete
npm run curate -- vault CVAULT...  # one vault, every field, plus its protocol's
```

`vaults` lists the missing field names per vault, so it doubles as the to-do list. A vault with
no `protocolId` is incomplete.

### Fill a field

```bash
npm run curate -- vault-set CVAULT... protocolId blendv2
npm run curate -- vault-set CVAULT... displayName "Blend XLM Vault"
npm run curate -- vault-set CVAULT... description "A fixed-yield market backed by Blend Capital's XLM lending vault on Stellar."
```

One field per invocation. Over HTTP you can set several at once:

```bash
curl -X PATCH "$API/admin/vaults/CVAULT..." \
  -H "X-Admin-Key: $MY_CURATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "protocolId": "blendv2",
        "displayName": "Blend XLM Vault",
        "note": "audit reviewed 2026-08-30"
      }'
```

Send `null` to clear a field. Omit a field to leave it untouched. Pointing `protocolId` at a slug
that has no row is rejected (400 over HTTP) — create the protocol first.

### The fields

Four are curated by you:

| Field | Max | Example |
|---|---|---|
| `protocolId` | — | `blendv2` — slug of an existing protocol |
| `displayName` | 500 | `Blend XLM Vault` |
| `description` | 2000 | prose shown on the details page |
| `riskText` | 2000 | prose shown under "Risk involved" |

The old `protocolName` / `protocolLogoUrl` / `protocolWebsite` / `protocolDocsUrl` /
`protocolAuditUrl` names are **rejected** on a vault — they live on the protocol now. The public
API still serves them flat on each vault, joined from its protocol, so the frontend is unchanged.

Three more are filled automatically by the indexer from the vault contract and are **rejected**
if you try to set them — the indexer owns them and would overwrite a hand edit on the next
market anyway:

- `underlyingSymbol` — e.g. `XLM`, via `query_asset()` then the token's `symbol()`
- `underlyingAsset` — the asset contract address
- `pool` — the protocol contract the vault supplies to (Blend pool, XOXNO controller), via the adapters' `get_protocol()`

All three are best-effort. A vault that doesn't answer still indexes; the columns stay `null`.

---

## Adding a new yield protocol

1. `npm run curate -- protocol-add <slug> "<Name>"`, then `protocol-set` the logo and links.
   If the logo is new, commit the image to `frontend/public` first and point `logoUrl` at it.
2. Let the indexer pick up the first market on the new vault. This creates the `Vault` row and
   fills `underlyingSymbol` / `underlyingAsset` / `pool` on its own.
3. `npm run curate -- vaults` — the new vault appears, flagged incomplete.
4. `vault-set` its `protocolId` to the slug from step 1, then its `displayName`, `description`
   and `riskText` (or one HTTP `PATCH` with all four).
5. `npm run curate -- vault CVAULT...` to confirm nothing is left as `—`.
6. `npm run curate -- approve <marketId>` for each market on that vault.

Step 6 last: approving before steps 1 and 4 puts a market on the frontend with placeholder copy.

## Adding a second vault to an existing protocol

Blend adding USDC lending is steps 2 to 6 only — the protocol row already exists, so the new
vault needs just `protocolId` and its three own fields. Nothing about Blend gets retyped.

---

## Ordering and expiry

You cannot pin or reorder markets — everything sorts by `maturity` ascending. There is no
`sortWeight`.

Expiry is separate from curation, and consistent across the read endpoints:

- `GET /markets`, `/vaults/:address/markets`, `/vaults` — listed **and** unexpired by default;
  pass `?includeExpired=true` on the first two for a matured view.
- `GET /accounts/:address/balances` — listed markets **including expired ones**, deliberately.
  Someone holding PT in a matured market still needs to see it in order to redeem.

There is no public way to fetch unlisted markets. The review queue is the key-gated
`GET /admin/markets`.

---

## Troubleshooting

**Everything returns 503.** No curator credentials are configured on the API process. This is the
fail-closed path; a supplied key still gets 503, since there is nothing to compare it against.
A malformed `ADMIN_API_KEYS` entry (no `=`, a short secret, a name listed twice) is an error on
every request rather than a silently skipped curator; the message names the entry.

**401 with what looks like the right key.** The comparison is exact and constant-time — check for
a trailing newline from however you exported it.

**A market won't appear after approving.** Check maturity: `GET /markets` hides expired markets
regardless of `listed`. Confirm with `?includeExpired=true`.

**Bulk curation gets rate-limited.** It shouldn't — `/admin` is mounted ahead of the public
60/min limiter and has its own 300/min budget. If you're seeing 429s from a script, you're
hitting a public route.

**`unknown field` on a vault PATCH.** Either a typo, one of the three indexer-owned columns, or
one of the five protocol fields that now live on `/admin/protocols/:id`. The CLI's usage text
lists the settable names for both.

**`no protocol with id` on a vault PATCH.** The slug has no `Protocol` row yet, or is misspelled.
`npm run curate -- protocols` lists what exists; `protocol-add` creates it.

**409 on `POST /admin/protocols`.** That slug is taken. Use `PATCH` to edit it, or pick a new
slug if this is genuinely a different protocol version.
