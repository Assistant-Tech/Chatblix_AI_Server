# Archived docs

**Do not use these as the design reference for this AI backend.**

These docs are kept for history and for the team building the **main
backend**. They were written before the scope was clarified that:

- This NestJS service is an AI microservice only.
- Channels (WhatsApp/Instagram/etc.) live in the main backend.
- Conversations are owned by the main backend.
- Operators are managed by the main backend.

The four docs here either pre-date that clarification, or describe
responsibilities that have since moved to the main backend.

| File | Why it's archived | Still useful for |
|---|---|---|
| `MULTI_TENANT_PLAN.md` | Assumed this service handles channels + operator queue + tenant onboarding. | Main backend team — phases T1–T2 (profile + cache + context) carry over conceptually; T6 (channels) and T7 (operators) are their domain. |
| `IMPLEMENTATION_GUIDE.md` | Full WhatsApp/Instagram webhook design + operator JWT flow + tenant REST API — all main-backend concerns. | Main backend team — §2 (Meta API specifics) and §4.1–4.3 (tenant + webhook + operator endpoints) are useful starting points. |
| `KB_PLAN.md` | Designs `Business` + `BusinessKbVersion` + `ApiKey` tables in this service; in the new architecture those tables live in the main backend. | Main backend team — §2 (JSONB-per-business storage), §3 (CRUD APIs), §5 (validation rules) are directly applicable to their KB editor. |
| `NEXT_PHASE.md` | Older phased roadmap; mixes AI-backend work (M1, M4, M5, M6, M7) with main-backend work (M2 channel adapter, M3 operator API). | Both teams — useful to skim for context on how the system evolved. |

For the **current** design of this AI backend, read `../AI_BACKEND_ARCHITECTURE.md`,
`../KB_MANAGEMENT.md`, and `../COST_AND_BILLING.md`.
