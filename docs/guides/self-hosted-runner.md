# Self-hosted GitHub Actions runner

Every workflow picks its runner from the repo variable `RUNNER_LABEL`. Unset,
jobs run on GitHub's hosted runners (`ubuntu-latest`). Set it to a
self-hosted runner's label and jobs run there instead, which doesn't use the
account's Actions minutes.

| Variable | Used by | Unset |
| --- | --- | --- |
| `RUNNER_LABEL` | every job, plus the arm64 half of `docker-publish.yml` | `ubuntu-latest` (arm64 images: `ubuntu-24.04-arm`) |
| `AMD64_RUNNER_LABEL` | the amd64 half of `docker-publish.yml` | `ubuntu-latest` |

Set them under **Settings → Secrets and variables → Actions → Variables**.
Delete `RUNNER_LABEL` to go back to hosted runners.

Workflows you start by hand (Fly deploys, Docker images, client and metrics
publishing) also have a **Runner** choice on the "Run workflow" form:
`default` follows `RUNNER_LABEL`, `rw-wsl` is the self-hosted runner,
`ubuntu-latest` is GitHub's. Automatic runs (CI on pull requests, the release
on a push to main) always follow the variable.

## arm64 runners

The current self-hosted runner is a WSL2 Ubuntu box on arm64 (label `rw-wsl`).

- **Fly deploys** (`fly-deploy.yml`, `fly-deploy-simulator.yml`) pass
  `--remote` on an arm64 runner, so Fly's amd64 builder builds the image. A
  local build there would produce an arm64 image Fly can't run.
- **amd64 Docker images** stay on `AMD64_RUNNER_LABEL` (GitHub's amd64 runner by
  default): building them under emulation isn't reliable (see the note in
  `docker-publish.yml`). If that job can't run, only the on-prem images are
  skipped; the release tag, GitHub Release and clients are separate jobs.

## Setting up a runner

1. GitHub: **Settings → Actions → Runners → New self-hosted runner** (Linux,
   ARM64) and copy the token.
2. On the machine:

   ```sh
   mkdir -p ~/actions-runner && cd ~/actions-runner
   # download + checksum-verify the linux-arm64 tarball from the page above, then:
   ./config.sh --url https://github.com/rockwarehq/rw-server --token <TOKEN> \
     --name "$(hostname)-wsl" --labels rw-wsl --unattended
   sudo ./svc.sh install "$USER" && sudo ./svc.sh start   # needs systemd (WSL: [boot] systemd=true)
   ```

3. Set `RUNNER_LABEL=rw-wsl`.

On a self-hosted runner, workflows don't upload caches to GitHub (slow, and
pointless there): pnpm reuses its store on the machine's disk, and Docker
builds cache under the runner's tool cache folder.

A runner takes one job at a time; jobs queue until it's free or online
(WSL stops when Windows sleeps). Register more runners on the same machine
(separate directories, same label) to run jobs in parallel.

Jobs run with the repo's secrets on that machine, so only use self-hosted
runners for this private repo, never for public repos or pull requests from
forks.
