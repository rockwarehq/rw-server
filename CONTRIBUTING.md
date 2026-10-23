# How we work

Two branches, both protected:

- **`dev`** — where all work goes. You branch from it and PR into it.
- **`main`** — released code only. It only ever gets PRs from `dev` (or a hotfix).

You never push to `dev` or `main` directly.

---

## One-time setup

```sh
sudo apt install gh        # or: brew install gh
gh auth login              # GitHub.com → HTTPS → Yes → Login with a web browser
```

Your GitHub password won't work for `git push`; `gh auth login` takes care of that.

---

## Everyday work

**1. Start from the latest `dev`**

```sh
git switch dev
git pull
git switch -c feat/short-name      # or fix/short-name
```

**2. Commit as often as you like** — the commits get squashed into one when merged.

**3. Push and open a PR into `dev`**

```sh
git push -u origin feat/short-name
gh pr create --base dev --fill
```

**4. Merge it** — wait for the **CI / quality** check to go green, then click
**Squash and merge**. Give the PR a clear title — it's what shows up in the
release notes.

**5. Delete your branch** — click **Delete branch** on the merged PR.

Then go back to step 1 for the next thing.

---

## Database migrations

- Create them the usual way: `pnpm db:migrate:dev`.
- The migration folder name must sort **after** every existing one. If you
  rebased onto newer `dev` and someone else's migration is now later than
  yours, rename your folder to a newer timestamp.
- Never edit a migration that's already on `dev`. Add a new one.

### First pull after the v1 squash

The old 151 migrations were squashed into `20261016000000_v1_baseline`. If
your local database is from before that, run this once:

```sh
pnpm db:migrate
```

then, in your **local** database only:

```sql
DELETE FROM _prisma_migrations WHERE migration_name <> '20261016000000_v1_baseline';
```

Otherwise `pnpm db:migrate:dev` will offer to reset your database. Never run
that `DELETE` on a deployed database.

---

## Releasing (`dev` → `main`)

**1. Open the release PR**

```sh
gh pr create --base main --head dev --title "Release v1.2.0 — short description"
```

The title **must start with `Release vX.Y.Z`**. That version becomes the tag;
anything after it is the release's name. Pick the version:

| Change | Bump | Example |
|---|---|---|
| Fixes, CI-only changes | patch | `v1.2.0` → `v1.2.1` |
| Normal release (features, migrations) | minor | `v1.2.0` → `v1.3.0` |
| New product generation (rare, decided together) | major | `v1.x` → `v2.0.0` |

If something in the release is breaking (e.g. it needs a new rw-ui), say so in
the title or description.

**2. Wait for the checks** — `quality`, `source-branch`, `release-title`.

**3. Click Merge pull request** (a merge commit — not squash).

That's it. On merge, GitHub automatically:

- tags the version and creates a GitHub Release with notes
- publishes the Docker images (`latest`, the version, and the commit)
- publishes the RPC and API clients — **only if** you bumped the version in
  `packages/rpc-client/package.json` or `packages/api-client/package.json`.
  Not bumped = skipped, not failed.

Releasing does **not** deploy anything. Deploy Fly tenants from
**Actions → Deploy to Fly.io** (customer tenants only accept `main`).
On-prem sites pick up `latest` on their next `docker compose pull`.

---

## Hotfixes (something broken in production)

1. Fix it on `dev` first, like everyday work.
2. If `dev` is ready to release, just release `dev` → `main` (patch version).
3. If `dev` has unfinished work you can't ship yet:

   ```sh
   git fetch
   git switch -c hotfix/short-name origin/main
   git cherry-pick <the fix's commit from dev>
   git push -u origin hotfix/short-name
   gh pr create --base main --title "Release v1.2.1 — fix short description"
   ```

   The branch name **must** start with `hotfix/`.

---

## If something's blocked

| Message | Fix |
|---|---|
| `source-branch` failed | Your PR targets `main`. Change the base to `dev` (**Edit** next to the PR title). |
| `release-title` failed | Title must start with `Release vX.Y.Z`, with a version newer than the last release. |
| "Merging is blocked" | Wait for the checks; something must be green. |
| `git push` asks for a password | Run `gh auth login`. |
| `db:migrate:dev` wants to reset | See [First pull after the v1 squash](#first-pull-after-the-v1-squash). |
