# Station simulator (`@rw/sim-app`)

Makes stations look like real machines. For each enabled station it publishes
cycle signals onto the tag that station's `imm.cycle_completed` hook watches,
paced off the station's live effective standard (job, profile, cycle mode).
Everything downstream — livestore hooks, cycle recording, slow/down detection,
metrics — runs for real.

```
pnpm dev:sim          # http://localhost:30200
```

Needs `DATABASE_URL` (reads stations, hooks, standards), `NATS_URL`, and
`SIM_API_URL`. See `.env.example`.

Sign in with your Rockware account: the UI logs in through the platform API's
`/auth/login` (like rw-imm) and keeps the session in httpOnly cookies. Only
users of the workspace that owns the stations get in.

## Behavior

Each station is in one of two modes:

- **Auto** — runs like a real machine: mostly normal, with random stretches of
  great, slow, short stops and downtime.
- **Program** — a list of steps that loops forever. A step is either **Rate**
  (speed ×multiplier, ± variation % of random cycle-to-cycle difference) or **Stop**, and runs for N minutes; a step with no
  length holds until the program is changed. Each step row has presets
  (×1, +20%, −20%, Stop) for quick setup.

Multipliers act on rate: cycle time = standard ÷ multiplier. Count-by-time
stations keep their report interval and scale the count instead.

## Things to know

- Stations start **disabled**; the simulator never touches a station until you
  turn it on.
- **Tag to update** picks which tag the simulator publishes to: the cycle
  hook's tag (default), any other tag property on the station's livestore
  node, or a custom device/path. Add e.g. a "Sim Cycle" tag property
  (`deviceId: sim`) to a station node and it shows up after the next refresh;
  point the cycle hook at it so the gateway's tag stops counting.
- If a gateway also publishes on the tag you're driving you get double cycles;
  the UI flags it. Use a separate sim tag (above) or unpublish that datasource.
- Stations, jobs and standards are re-read from the DB every 15 s
  (`SIM_DISCOVERY_MS`), and on page load or the Refresh button, so job and
  standard changes made in the app reach the running stations.
- Only stations with an `imm.cycle_completed` hook on a tag show up.
- Config lives in one JSON file (`SIM_CONFIG_PATH`, default `./data/sim.json`).

## Run against the Fly sim tenant

```
fly proxy 14222:4222 -a sim-nats      # keep running
# once, in your own terminal (keeps the secret out of logs/chat):
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$(fly ssh console -a sim-livestore -C 'printenv DATABASE_URL' 2>/dev/null | tr -d '\r')|" .env.fly-sim
pnpm --filter @rw/sim-app dev:fly-sim # http://localhost:30201
```

Uses `.env.fly-sim` (gitignored) and its own config file (`data/sim.fly-sim.json`),
so local and Fly settings never mix. Publishing reaches livestore through the
sim gateway's NATS leaf, so that gateway must be connected.

## Deploy

Separate from the platform deploy: run the **Deploy simulator to Fly.io**
GitHub Action (`.github/workflows/fly-deploy-simulator.yml`), or locally
`pnpm fly:deploy --app sim sim`. Config: `fly/base.toml` +
`fly/tenants/<tenant>.toml` (one machine, `/data` volume, never auto-stops).
The Fly app needs `DATABASE_URL` and `NATS_URL` secrets.
