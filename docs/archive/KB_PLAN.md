# KB Storage & API Plan (per-business)

_Scope: how knowledge bases are stored and managed for multiple businesses.
The LLM pipeline (Triage → Generator → Validator) does **not** change — only
where it reads `BusinessContext` from. Reference: sambad.io product model
(multi-tenant, channels per plan, "train it with FAQs + product catalog +
policies", catalog sharing in chat)._

_Date: 2026-05-12_

---

## 1. Reference signal from sambad.io

| Concept | Sambad approach | Our takeaway |
|---|---|---|
| Onboarding | "Live in under an hour", 7-day free trial. | Onboarding ≈ create `Business` + seed KB → done. |
| KB content | FAQs, product catalog, policies, "tool actions / custom workflows" (Growth+). | Reuse the field set we already encode in `fresh-and-more.json`. |
| Catalog | Synced from connected ERP (Blanxer; Shopify/WooCommerce soon) or sent inline in chat. | Catalog must be **editable as data**, not as prose. JSON, not Markdown. |
| Plans | Starter/Growth/Enterprise gate channels, users, AI messages, custom workflows. | Plan/quota fields live on `Business`, not on the KB. |
| KB editor | No public docs — they appear to have a dashboard form, not file uploads. | API-first; dashboard later. |

Phase-2 goal: a new business is onboardable by **one POST** to create the
business and **one PUT** to install its KB. Nothing else.

---

## 2. Storage model

### 2.1 Decision: single JSON column, versioned

Store the entire KB as one `kb_json` JSONB column on `Business`, with a
separate `BusinessKbVersion` table that snapshots every change.

**Why this and not normalized tables:**
- `PromptsService.getBusinessContext()` already returns a flat object with
  `product_catalog`, `locations`, `hours`, `delivery_policy`,
  `payment_methods`, `current_offers`, `brand_voice`,
  `high_value_threshold_npr`, `timezone`, `channels`, `size_chart_url`,
  `size_guidance`, `cod_policy`, `return_and_exchange_policy`,
  `loyalty_program`, `emi_options`, etc. The pipeline just `JSON.stringify`s
  this into the generator's system payload. Normalizing into tables and
  re-assembling on every turn is pure overhead.
- The existing on-disk KBs (`fresh-and-more.json`, `clothing-store.json`)
  drop in as the first DB rows with **zero shape conversion**.
- Section edits ("update product catalog only") stay easy via PostgreSQL
  `jsonb_set` and our PATCH endpoint.
- We don't query inside the KB today (no "find products under NPR 1000"
  endpoint). The day we need that, lift just `products` into its own table
  and keep the rest in `kb_json` — additive, not a rewrite.

**When we'd revisit:** product catalog grows past ~1 MB per business, or
operators need typed-form editing per product row. Until then JSONB wins.

### 2.2 Prisma schema additions

```prisma
model Business {
  id           String   @id @default(uuid())
  slug         String   @unique          // url-safe, e.g. "fresh-and-more"
  name         String
  status       String   @default("active") // active | suspended | trial
  plan         String   @default("starter") // starter | growth | enterprise
  kb_json      Json     @default("{}")     // structured BusinessContext
  kb_version   Int      @default(1)
  created_at   DateTime @default(now())
  updated_at   DateTime @updatedAt

  versions     BusinessKbVersion[]
  api_keys     ApiKey[]
}

model BusinessKbVersion {
  id           String   @id @default(uuid())
  business_id  String
  version      Int
  kb_json      Json
  edited_by    String?                    // admin actor (email or "system")
  note         String?                    // optional change note
  created_at   DateTime @default(now())

  business     Business @relation(fields: [business_id], references: [id], onDelete: Cascade)

  @@unique([business_id, version])
  @@index([business_id, created_at])
}

model ApiKey {
  id            String   @id @default(uuid())
  business_id   String
  key_hash      String   @unique          // sha256(key); never store the key
  label         String                    // "widget", "messenger", "test"
  last_used_at  DateTime?
  revoked_at    DateTime?
  created_at    DateTime @default(now())

  business      Business @relation(fields: [business_id], references: [id], onDelete: Cascade)

  @@index([business_id])
}
```

Existing `Lead`, `Message`, `TurnLog` get a nullable `business_id` in the
same migration (backfilled to a "default" business so dev data survives),
flipped to NOT NULL in a follow-up once backfill verifies.

### 2.3 KB shape (the JSON itself)

The contract for `kb_json` is exactly the union of fields
`PromptsService.getBusinessContext()` reads today, frozen as a JSON Schema
in `src/common/types/kb.schema.ts`:

```ts
{
  // identity
  business_name: string,
  industry: string,
  timezone: string,                 // e.g. "Asia/Kathmandu"

  // commerce
  product_catalog: Array<{
    id?: string,
    name: string,
    price_npr: number,
    sku?: string,
    image_url?: string,
    options?: Record<string, string[]>,   // e.g. { size: ["S","M","L"] }
    notes?: string
  }>,
  current_offers?: Array<{ title: string, details: string, valid_until?: string }>,
  high_value_threshold_npr?: number,

  // policy
  delivery_policy?: { zones?: string[], cod_available?: boolean, eta_days?: string, fee_npr?: number, notes?: string },
  payment_methods?: string[],       // ["COD","eSewa","Khalti","Bank","Card"]
  cod_policy?: string,
  return_and_exchange_policy?: string,
  loyalty_program?: string,
  emi_options?: string,

  // location / hours
  locations?: Array<{ name: string, address: string, phone?: string, hours?: string }>,
  hours?: Record<string, string>,   // { mon: "10:00-19:00", ... }

  // sizing (apparel)
  size_chart_url?: string,
  size_guidance?: string,

  // voice
  brand_voice?: { tone?: string, do?: string[], dont?: string[], sample_phrases?: string[] },

  // channels (informational; real channel wiring is a separate table later)
  channels?: string[],              // ["messenger","whatsapp","widget"]

  // free-form
  faqs?: Array<{ q: string, a: string }>,
  notes?: string
}
```

All fields are optional except `business_name` and `industry`. Validation
runs server-side on every PUT/PATCH (Zod or `class-validator`); a 422 with
field-level errors goes back to the caller — no half-valid KB ever lands.

---

## 3. APIs

All admin endpoints live under `/api/admin/*` and require an
`X-Admin-Key` header (single platform admin key in env for Phase 2;
per-user admin auth is Phase 3). The pipeline-facing chat endpoints
(`/api/chat*`) keep using `X-Chatblix-Key` (the per-business `ApiKey`) and
never accept KB writes.

### 3.1 Business CRUD

| Method | Path | Purpose |
|---|---|---|
| `POST`   | `/api/admin/businesses` | Create a business (returns generated `slug` if not provided). |
| `GET`    | `/api/admin/businesses` | List, paginated (`?cursor=&limit=`). |
| `GET`    | `/api/admin/businesses/:id` | Fetch one (by `id` **or** `slug`). |
| `PATCH`  | `/api/admin/businesses/:id` | Update name / status / plan. **Never** touches `kb_json`. |
| `DELETE` | `/api/admin/businesses/:id` | Soft-delete (sets `status="suspended"`). Hard delete only via DB. |

**`POST /api/admin/businesses`**
```json
// request
{ "slug": "fresh-and-more", "name": "Fresh & More", "plan": "growth" }
// 201
{ "id": "uuid", "slug": "fresh-and-more", "name": "Fresh & More",
  "plan": "growth", "status": "active", "kb_version": 1, "created_at": "..." }
```

### 3.2 KB read / write

| Method | Path | Purpose |
|---|---|---|
| `GET`   | `/api/admin/businesses/:id/kb` | Return the current `kb_json` and `kb_version`. |
| `PUT`   | `/api/admin/businesses/:id/kb` | **Full replace.** Validates against KB schema, bumps `kb_version`, snapshots to `BusinessKbVersion`. |
| `PATCH` | `/api/admin/businesses/:id/kb` | **Section merge.** Deep-merge top-level keys only; arrays are *replaced*, not concatenated. Same validate+version+snapshot flow. |

**`PUT /api/admin/businesses/:id/kb`**
```json
// request — the entire KB object from §2.3
{ "business_name": "Fresh & More", "industry": "grocery_retail", ... }
// 200
{ "kb_version": 7, "updated_at": "...", "validation": { "ok": true } }
// 422 on schema failure
{ "validation": { "ok": false, "errors": [
  { "path": "product_catalog.3.price_npr", "message": "must be a positive number" }
] } }
```

**`PATCH /api/admin/businesses/:id/kb`** — only the keys you send are
updated; everything else stays. Example: update only the product catalog
without resending policies.
```json
{ "product_catalog": [ { "name": "Face mask 50pcs", "price_npr": 950 } ] }
```

### 3.3 KB history / rollback

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/admin/businesses/:id/kb/versions` | List versions (newest first, paginated). |
| `GET`  | `/api/admin/businesses/:id/kb/versions/:version` | Fetch a specific snapshot. |
| `POST` | `/api/admin/businesses/:id/kb/versions/:version/restore` | Restore a snapshot as a **new** version (no in-place rewind). |

### 3.4 KB preview (dry-run)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/businesses/:id/kb/preview` | Run **one** pipeline turn against a candidate KB **without** persisting it. |

```json
// request
{ "message": "face mask kati ho?", "kb_override": { ... full KB ... },
  "history": [] }
// 200
{ "reply": "Hajur, face mask ko price NPR 950 ho.",
  "triage": { ... }, "verdict": { "pass": true, "violations": [] } }
```

This is the "edit, preview, save" loop a dashboard will use. The pipeline
code path is untouched — `PromptsService.getBusinessContext()` just gets
the override instead of the persisted row for this one request.

### 3.5 API keys (per business, for the chat surface)

| Method | Path | Purpose |
|---|---|---|
| `POST`   | `/api/admin/businesses/:id/keys` | Mint a new key. Returns the plaintext **once**; only the hash is stored. |
| `GET`    | `/api/admin/businesses/:id/keys` | List metadata (label, last_used_at, revoked_at). No plaintext. |
| `DELETE` | `/api/admin/businesses/:id/keys/:keyId` | Revoke. |

---

## 4. Pipeline integration (the only code that changes)

### 4.1 `PromptsService` — DB-backed lookup

Today it reads from disk:
```ts
private async loadKb(kbFileName: string)
```
becomes:
```ts
async getBusinessContext(business: { id: string; kb_json: unknown })
```
and the orchestrator passes the resolved `Business` (already attached to
`req` by `ApiKeyGuard`) instead of a `kb_file` string. The in-memory
`kbCache` keys by `business_id + kb_version` so the next turn skips the
DB read until the KB changes.

`{{BUSINESS_NAME}}` substitution stays as-is, reading from `kb_json.business_name`.

### 4.2 Chat request shape

`ChatStreamRequestDto` drops `kb_file`. `business_id` is derived from the
API key, never from the body. This is the only externally visible change
to the chat API.

### 4.3 Migration of the two on-disk KBs

A `prisma/seed.ts` script:
1. Inserts a `Business` row per file (`fresh-and-more`, `clothing-store`).
2. Loads the JSON into `kb_json` verbatim — the schema already matches.
3. Writes a `BusinessKbVersion` row as version 1.
4. Mints one `ApiKey` per business for local dev (printed to stdout, never
   stored elsewhere).

Files in `src/pipeline/kb/` stay in the repo only as seed fixtures; the
runtime stops reading them.

---

## 5. Validation & safety

- **Schema validation on every write.** Reject unknown top-level keys
  (`additionalProperties: false`) so typos don't silently widen the
  contract.
- **Size cap.** Reject `kb_json` > 256 KB serialized (room to grow without
  blowing the system-prompt token budget). Catalog beyond that signals
  it's time to normalize products.
- **No PII in KB.** Validator rejects fields named `customer_*`, `phone`,
  `email`, etc. KB is business data only.
- **Idempotent writes.** PUT with an `If-Match: <kb_version>` header
  returns 409 if the version changed under you. PATCH always wins-last but
  produces a new version row, so concurrent edits are recoverable.

---

## 6. Out of scope for this slice

These show up in `NEXT_PHASE.md` but are **not** part of the KB work:

- Channel adapters (Messenger / WhatsApp / widget) — separate module.
- Admin UI / dashboard — API-only for now.
- Per-user admin auth, audit log of who edited what — Phase 3.
- Importers (CSV product upload, Blanxer/Shopify sync, web crawl) — Phase
  3. The PUT/PATCH endpoints are the substrate every importer eventually
  writes to.
- Tool/workflow registration (the sambad "custom workflows" concept) —
  out of scope; would land as a sibling `tools_json` column when needed.

---

## 7. Minimal sequence to ship this

1. **Migration** — `Business`, `BusinessKbVersion`, `ApiKey` tables;
   nullable `business_id` on `Lead`/`Message`/`TurnLog`.
2. **Seed script** — port `fresh-and-more.json` and `clothing-store.json`
   into rows.
3. **`ApiKeyGuard`** — attach `req.business` on `/api/chat*`.
4. **`AdminKeyGuard`** + the eight admin endpoints above.
5. **`PromptsService` DB lookup** + `kbCache` keyed by `(business_id, kb_version)`.
6. **Drop `kb_file`** from `ChatStreamRequestDto`. Update Swagger.
7. **Smoke test** — create business via `POST /api/admin/businesses`, PUT
   KB, mint key, hit `/api/chat/stream` with the key → same reply quality
   as the file-backed run.

That's the whole slice. Once it's in, onboarding a new business is two
HTTP calls plus key distribution.
