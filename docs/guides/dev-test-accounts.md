# Dev test accounts

Sign-ins for trying each kind of access on the **dev** tenant
(`https://dev.rockware.io`, API `https://dev-api.rockware.io`). These are
dev-only accounts with an easy shared password. Never reuse them on a
customer tenant.

Password for every test account below: **`Rockware-dev1`**

| Email | What they can do (at the Rockware plant) |
|---|---|
| `admin@example.com` | Account admin: everything, everywhere. Password `changeme123` (seeded). |
| `plant-viewer@rockware.dev` | Plant VIEW: reads the plant's shared data; no workcenters. |
| `plant-member@rockware.dev` | Plant MANAGE (member): changes jobs, orders, products, tools; no workcenters. |
| `plant-admin@rockware.dev` | Plant ADMIN: shop-floor setup and people; reaches every workcenter. |
| `wc-viewer@rockware.dev` | Workcenter VIEW on Mold: watches that cell; reads the plant. |
| `shift-supervisor@rockware.dev` | Workcenter MANAGE on Mold: runs that cell; reads the plant. |
| `multi-cell-crew@rockware.dev` | Workcenter MANAGE on Mold and Assembly; reads the plant. |
| `planner-supervisor@rockware.dev` | Plant MANAGE + workcenter MANAGE on Mold. |
| `maintenance@rockware.dev` | Plant MANAGE + workcenter MANAGE on every cell (Assembly, Mold, Paint, Sample). |

Rockware staff accounts (SUPPORT, ENGINEER) are not set up on dev yet.
Staff roles can't be given through the API; create them with
`apps/api/scripts/create-system-user.ts` on the dev API machine.

## How they were made

Through the dev API as the account admin, the same way a real person is
added: invite with the access above, sign in with the temporary password,
then change it to the shared one (which activates the account). To add
another, invite it from Settings → Members and change its password the
same way.

See `packages/auth/README.md` for what each level means.
