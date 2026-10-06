# 2단계 서버 자료실 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove virtual note bodies from the current static output and GitHub head, then render the same four virtual notes through an intentionally anonymous Vercel API backed by Supabase.

**Architecture:** Store only the table schema in Git; insert the four fictional rows into Supabase separately. A Vercel Node.js function reads the table with a server-only Supabase secret key, while the browser fetches `/api/notes`. The endpoint remains anonymous until a later stage.

**Tech Stack:** Node.js 22+ ESM, Vercel Node.js Functions, `@supabase/supabase-js` (already installed), Supabase Postgres, existing `node:test` suite.

**Spec:** `docs/superpowers/specs/2026-10-06-stage-2-server-backed-notes-design.md`

## Global Constraints

- Keep exactly the four current fictional notes in the page and Supabase table.
- Keep note bodies out of `supabase/schema.sql`, static assets, README, GitHub head, logs, and submission JSON.
- Use `owner_id uuid` with no foreign key to `auth.users`.
- Enable RLS, deny direct table reads to `anon` and `authenticated`, and grant only the server's `service_role` `SELECT` access.
- Read `SUPABASE_URL` and `SUPABASE_SECRET_KEY` only inside the Vercel function; the user enters the secret in Vercel's environment-variable UI.
- Keep `GET /api/notes` anonymously callable and document that it returns fictional data until step 3.
- Keep `judgeIssuer` unchanged; set `aleph.config.json.step` to `2` and leave step-3 `allowedRoutes` and step-5 `originalApiUrl` unset.
- Preserve the deployment identity shape while allowing its `step` to be `2`.
- The linked Supabase project is `defense`; the linked Vercel project is `choi-bujang-secret-vault`.
- Vercel currently reports deployment protection enabled for all non-custom domains. Make the production domain public while keeping preview deployments protected; use Standard Protection rather than turning off all protection.
- Do not describe historic public commits or deployments as erased.
- Do not commit `bundle-notes.json` or `artifacts/submission.json`.

## Review Focus

- Table permission and RLS mismatch: verify `anon` and `authenticated` cannot select, while `service_role` can.
- Missing or invalid Vercel environment variables: return a generic error without key values, database details, or note bodies in logs.
- Stale static content or cache: verify the built output has no `/data.json` note body and the API response uses `Cache-Control: no-store`.
- Anonymous API behavior: verify GET returns four fictional rows, non-GET is rejected, and the response never contains environment values.
- Vercel deployment protection: verify anonymous access at the production alias after switching to Standard Protection; preview deployments remain protected.

---

### Task 1: Lock the stage-2 self-check contract

**Files:**
- Modify: `test/r5.test.mjs`
- Test: `test/r5.test.mjs`

**Interfaces:**
- Consumes: `deploymentIdentity(env, config)` and `runAttackChecks(config)`.
- Produces: stage-2 assertions for deployment identity and actual anonymous request summaries.

- [ ] Update the deployment identity fixture to `step: 2`; assert the existing identity schema and marker remain while its `step` field is `2`.
- [ ] Replace the `data.json`-only attack-check fixture with stubs for `GET /api/notes` returning four fictional rows and `GET /data.json` returning 404; assert both requests use `redirect: 'error'` and no authorization header.
- [ ] Assert the self-check reports the observed HTTP status/count without including a note body or a key value.
- [ ] Run `npm run test:r5` and confirm it fails because the current implementation still expects stage 1 and `/data.json`.

### Task 2: Create the Supabase table and seed the existing fictional rows

**Files:**
- Create: `supabase/schema.sql`

**Interfaces:**
- Consumes: the current four rows in `data.json` during this migration only.
- Produces: `public.vault_notes` with `id`, `sort_order`, `owner_id`, `title`, and `content` columns.

- [ ] Add DDL for `id uuid primary key default gen_random_uuid()`, unique `sort_order`, nullable `owner_id uuid`, and non-null `title` and `content`; do not add an `auth.users` foreign key.
- [ ] Enable RLS, define no `anon` or `authenticated` policies, revoke their table privileges, and grant `SELECT` to `service_role`.
- [ ] Apply the schema to the active Supabase project named `defense` using the connected Supabase tool or SQL Editor.
- [ ] Insert the four fictional rows into Supabase outside the repository; do not copy note bodies into the migration file.
- [ ] Verify the table columns, absent foreign key, RLS status, four-row count, and effective role grants. Expected: `anon`/`authenticated` direct reads denied; `service_role` can select.

### Task 3: Move the page read to the Vercel API and remove static note files

**Files:**
- Create: `api/notes.mjs`
- Modify: `public/index.html`
- Modify: `scripts/build-public.mjs`
- Modify: `scripts/deployment-identity.mjs`
- Delete: `data.json`
- Delete: `public/data.json`

**Interfaces:**
- Consumes: `public.vault_notes` and server environment variables `SUPABASE_URL`, `SUPABASE_SECRET_KEY`.
- Produces: anonymous `GET /api/notes` with JSON `{ notes: [{ title, content }] }` in display order.

- [ ] Implement a Vercel Web Standard handler that permits GET, rejects other methods, queries only the display fields, and returns `{ notes }` with `Cache-Control: no-store`.
- [ ] Return a generic failure response for missing environment values or Supabase errors; do not log keys, database error details, response bodies, or note bodies.
- [ ] Change the page fetch from `/data.json` to `/api/notes`; keep the existing safe `textContent` rendering and four-card behavior.
- [ ] Remove the build-time JSON copy/read path so `npm run build -- --local` no longer requires `data.json` and cannot recreate `public/data.json`.
- [ ] Update `deploymentIdentity` to accept the step-2 config and emit `step: 2` without changing the existing identity schema or `judgeIssuer`.
- [ ] Run `npm run test:r5`; expected: deployment identity and attack-check tests pass.
- [ ] Run `npm run build -- --local`; expected: build succeeds and `public/data.json` is absent.

### Task 4: Update stage configuration, README, and live self-checks

**Files:**
- Modify: `aleph.config.json`
- Modify: `README.md`
- Modify: `src/attack-check.mjs`
- Modify: `test/r5.test.mjs` if an assertion needs adjustment after implementation

**Interfaces:**
- Consumes: `/api/notes`, the production Vercel alias, and the actual Git origin.
- Produces: stage-2 config, learner verification steps, and one or more actual-request summaries for `npm run bundle`.

- [ ] Set `step` to `2`, set `repoUrl` to the normalized Git origin `https://github.com/gilin03/choi-bujang-secret-vault`, set `publicAppUrl` to the production alias `https://choi-bujang-secret-vault-umber.vercel.app`, and preserve `judgeIssuer`.
- [ ] Keep `allowedRoutes` empty and `originalApiUrl` null at this stage; retain the non-sensitive sample marker only for the existing deployment identity format.
- [ ] Update `runAttackChecks` to send real anonymous requests to `/api/notes` and `/data.json`; record status/count summaries only, never response bodies or guessed judge results.
- [ ] Document SQL Editor use, table/RLS inspection, Vercel environment-variable placement, expected browser results, anonymous API exposure, static/GitHub search steps, and the historical exposure limitation.
- [ ] Run `npm run test:r5`; expected: all stage-2 deployment identity and self-check assertions pass.

### Task 5: Configure and verify the connected Vercel deployment

**Files:**
- Vercel project settings for `choi-bujang-secret-vault`
- Vercel production environment variables

**Interfaces:**
- Consumes: the Supabase project URL, a user-entered server secret, and the latest GitHub `main` commit.
- Produces: public production alias serving the stage-2 app; protected preview deployments; a ready production deployment.

- [ ] Set production `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in Vercel project environment settings. The user enters the secret value directly in the official secret field; never request or print it.
- [ ] Change deployment protection to Standard Protection so the production alias is public and preview deployments remain protected.
- [ ] Build and review the stage-2 changes locally, then show the included files and secret/body scan results before the `2단계 저장점` commit.
- [ ] Commit the stage-2 changes as `2단계 저장점`, then push `main` so GitHub head and the connected production deployment update.
- [ ] Wait for the Vercel production deployment to become ready and verify the production alias anonymously. Expected: page shows four cards; `/api/notes` returns four fictional notes; `/data.json` has no note body; a non-GET API request is rejected.
- [ ] Verify an anonymous direct Supabase table read is denied. If the public request still receives Vercel Authentication, stop before changing protection beyond Standard Protection and report the exact response.

### Task 6: Generate and review the submission bundle

**Files:**
- Create locally, ignored: `bundle-notes.json`
- Generate locally, ignored: `artifacts/submission.json`

**Interfaces:**
- Consumes: clean Git status after the stage-2 commit, real `repoUrl`/`publicAppUrl`, and observed `runAttackChecks` responses.
- Produces: the submission JSON and console summary for step 2.

- [ ] Write a three-line explanation of the completed stage in ignored `bundle-notes.json`; do not include keys, note bodies, or judge claims.
- [ ] Run `npm run bundle` only after the production self-check can reach the new public deployment.
- [ ] If bundling fails, fix only the first reported error and rerun once after reviewing the failure.
- [ ] Show the generated JSON and its summary; confirm `bundle-notes.json` and `artifacts/submission.json` remain uncommitted.

## Execution Handoff

Tasks are sequential because the SQL schema, API response, page fetch, live deployment, and bundle checks share one data contract. Use native execution in the current session; delegated agents are not part of this plan.
