# Hosting RouteNorth in Canada for the pilot

Written 2026-11-15. This replaces the "systemd + Caddy on a VM" outline in `docs/PILOT_READINESS.md` (steps 3 to 8) with files that were built and run: a `Dockerfile` and `deploy/`. Read the "tested / not tested" table first, because the cloud account steps could not be run from here.

## Decision

**Host: Microsoft Azure, region Canada Central (Toronto), one Linux VM running Docker Compose.** The same files run on any Linux server, so moving to another provider later is a copy, not a rewrite.

Why this one, from my comparison on 2026-11-15 (vendor pages change; check before you pay):

| Option | What I found | Why not first |
| --- | --- | --- |
| **Azure Canada Central (Toronto)** | Toronto region with three availability zones; ordinary VMs, managed PostgreSQL and blob storage in Canada. | Chosen: a Canadian region the government and enterprise buyers already know, with a path from one VM to managed services. |
| DigitalOcean (Toronto) | Managed PostgreSQL is offered in Toronto; I could not confirm ordinary servers there. | Unconfirmed. Simpler and cheaper if it holds; worth checking before you commit. |
| Fly.io (Toronto) | Container machines can run in Toronto; its managed Postgres was in beta. | Beta database for customer data. |
| Render | No Canadian region. | Fails the data-in-Canada goal. |

**What "Canadian" means here.** A Toronto region keeps the data in Canada. Azure is still a US company, so do not call this "sovereign" or "Canadian-owned" in a sales email. For the government pitch, say "hosted in Canada (Toronto)". See `docs/GOVERNMENT_MARKET_RESEARCH.md` on what Ontario privacy guidance does and does not require.

**Cost.** I did not verify any price. Use the Azure pricing calculator for Canada Central with the size below (2 vCPU, 8 GB memory, 64 GB disk, one public IP) and add a few dollars a month for backup storage. A pilot with a handful of companies is a small server; do not buy managed Postgres until a client needs it.

## What runs where

One VM runs six containers from `deploy/docker-compose.yml`: Caddy (HTTPS on ports 80 and 443, certificates by itself), the web app, the API, the ingest service, Redis and PostgreSQL 16. A seventh one-shot container, `provision`, applies the database migrations and the `routenorth_app` grants at every start; it is safe to repeat. Only Caddy is reachable from the internet. The database and Redis have no published ports.

The web app has its API address built in, so **changing a domain needs a rebuild** (`up -d --build`), not just a restart.

## Tested / not tested

| Item | Status |
| --- | --- |
| `docker build` of the one image (install and build of API, ingest and web) | Run here. Image is large (about 2.2 GB); fine for a pilot. |
| `docker compose up` with the bundled database: migrations, role grants, all services healthy | Run here. |
| HTTPS through Caddy (here with Caddy's own local certificates on `*.localhost`), web page 200, API, ingest `/health`, WebSocket upgrade on `/live` returning 101 | Run here. |
| Sign-up, login, make a GPS key, push a position to `/ingest/feed`, see the new device on the Connect page; a wrong key gets 401 | Run here. |
| Stop and start again: data and login survive, `provision` repeats cleanly | Run here. |
| Same stack pointed at an external PostgreSQL (no `--profile bundled-db`) | Run here against a second Postgres container. Not against Azure's managed PostgreSQL. |
| `deploy/backup.sh` and restoring the dump into a scratch database | Run here. |
| First platform admin from the container (`admin:create`) | Run here. |
| Everything in "Steps 1 and 2" (Azure CLI, DNS), real Let's Encrypt certificates, a real domain | **Not run.** Needs your Azure account and domain. The commands are standard Azure CLI but unverified. |
| Real email (Resend), real Geotab or Samsara account, real tracker | **Not run.** Same as `docs/PILOT_READINESS.md`. |
| Copying backups to Azure storage | **Not run.** Outline only. |

## What only you can do

1. An Azure subscription (a credit card or an invoiced account). Creating the VM costs money, so I did not do it.
2. A domain you control, so you can add three DNS records.
3. A [Resend](https://resend.com) API key and a verified sender address if you want invites and password resets to arrive. Skip it for a first look.

## Steps

### 1. Create the server (on your computer, with the Azure CLI signed in)

```bash
az login
az group create --name routenorth-pilot --location canadacentral
az vm create --resource-group routenorth-pilot --name rn-pilot \
  --image Canonical:ubuntu-24_04-lts:server:latest --size Standard_B2ms \
  --os-disk-size-gb 64 --admin-username azureuser --generate-ssh-keys \
  --public-ip-sku Standard
az vm open-port --resource-group routenorth-pilot --name rn-pilot --port 80  --priority 900
az vm open-port --resource-group routenorth-pilot --name rn-pilot --port 443 --priority 910
az vm show -d -g routenorth-pilot -n rn-pilot --query publicIps -o tsv     # the server's address
```

`Standard_B2ms` is 2 vCPU and 8 GB. The web build needs the memory, so do not go smaller to save money. Then limit SSH (port 22) to your own address in the Azure portal: Virtual machines, rn-pilot, Networking.

### 2. Point three names at it

At your domain registrar, make three `A` records to the address from step 1, for example `app.yourcompany.ca`, `api.yourcompany.ca` and `ingest.yourcompany.ca`. Wait until `nslookup app.yourcompany.ca` shows the address. Caddy cannot get certificates until this works.

### 3. Prepare the server

```bash
ssh azureuser@<address>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker azureuser && exit        # log in again so the group applies
ssh azureuser@<address>
sudo mkdir -p /opt/routenorth && sudo chown azureuser /opt/routenorth
git clone https://github.com/aayushthakurintech/RouteNorth.git /opt/routenorth
```

If the repository is private, use a read-only deploy key or a fine-grained token for this one clone.

### 4. Fill in the settings

```bash
cd /opt/routenorth/deploy
cp .env.example .env && chmod 600 .env
# make a secret:   openssl rand -hex 32
nano .env
```

Set the three domains and replace every `change-me` with a different generated secret. Keep a copy of `.env` somewhere safe and private (a password manager): **if `ENCRYPTION_KEY` is lost, everyone with two-factor on must be reset.** Never commit `.env`.

### 5. Start it

```bash
docker compose --env-file .env -f docker-compose.yml --profile bundled-db up -d --build
docker compose --env-file .env -f docker-compose.yml --profile bundled-db ps
```

The first build takes several minutes. When it is done, `api`, `ingest` and `db` say `healthy` and `provision` says `Exited (0)`; that is correct.

### 6. Check it

```bash
curl https://api.yourcompany.ca/public/system-status    # {"level":"operational", ...}
curl https://ingest.yourcompany.ca/health                # ok
```

Open `https://app.yourcompany.ca/signup`, create a test company, and open **Owner Portal, Settings, Data sources**. To prove the GPS path, make a key on **Settings, Connect your GPS** and push one position (the field names are `lat`, `lng`, `time`, `speedKmh`):

```bash
curl -X POST https://ingest.yourcompany.ca/ingest/feed \
  -H "Authorization: Bearer rn_gps_..." -H "Content-Type: application/json" \
  -d '{"deviceId":"TEST1","positions":[{"lat":43.6532,"lng":-79.3832,"time":"2026-11-15T15:00:00Z","speedKmh":40}]}'
# {"received":1,"outcomes":{"stored":1,"unusable":0}}
```

### 7. Your staff account (the admin console)

```bash
docker compose --env-file .env -f docker-compose.yml --profile bundled-db run --rm --no-deps api \
  node apps/api/dist/admin/create-admin.js --email you@yourcompany.ca --name "Your Name"
```

It prints a temporary password, an authenticator key and recovery codes **once**. Store them in a password manager, not in chat. Sign in at `/login`; you are asked to choose a new password.

### 8. Backups (do this before the first client)

```bash
sudo mkdir -p /var/backups/routenorth && sudo chown azureuser /var/backups/routenorth
(crontab -l 2>/dev/null; echo '0 3 * * * /opt/routenorth/deploy/backup.sh >> /var/log/routenorth-backup.log 2>&1') | crontab -
/opt/routenorth/deploy/backup.sh          # run it once now
```

It keeps the newest 14 dumps and checks each can be read back. A copy that stays on the same disk is not a backup, so also copy the folder off the server, for example to an Azure storage account in Canada Central with `az storage blob upload-batch` (outline, not tested), or turn on Azure's VM backup. **Test a restore once** into a scratch database:

```bash
docker compose --env-file .env -f docker-compose.yml --profile bundled-db exec -T db createdb -U postgres scratch
docker compose --env-file .env -f docker-compose.yml --profile bundled-db exec -T db pg_restore -U postgres --no-owner -d scratch < /var/backups/routenorth/<file>.dump
```

### 9. Updating later

```bash
cd /opt/routenorth && git pull
cd deploy && docker compose --env-file .env -f docker-compose.yml --profile bundled-db up -d --build
```

Migrations run by themselves through `provision`. Take a backup first.

### 10. Giving a client access

Follow step 10 of `docs/PILOT_READINESS.md` (client signs up or you invite them, vehicles, GPS key, what to tell them) and the terms in `docs/PILOT_AND_LEGAL.md`. Candidates are in `docs/PILOT_PROSPECTS.md`.

## Using a managed database later

Create a PostgreSQL 16 database (Azure Database for PostgreSQL in Canada Central, for example), then in `deploy/.env` set `DATABASE_URL` (an admin login that may create roles) and `APP_DATABASE_URL` (user `routenorth_app` with the `APP_DB_PASSWORD` you chose), and start without `--profile bundled-db`. Use hex-only passwords so they are safe inside the URLs. Tested against a plain Postgres container only; some managed services restrict `CREATE ROLE`, in which case create `routenorth_app` yourself first and rerun `provision`.

## Known limits

- One server, no failover. A VM restart or an Azure fault means minutes to hours of downtime. Fine for a pilot, not for an SLA.
- No monitoring beyond `/public/system-status`; point an outside uptime check at it (any free one).
- Traccar is not in this stack. The pilot path is a provider pushing to a per-company GPS key, or the Geotab/Samsara connectors. A Traccar server for raw trackers needs its own open ports; see `docs/GO_LIVE.md`.
- Do not run `pnpm seed` here. It makes demo users with known passwords.
- Do not publish ports 5432 or 6379.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Browser says the certificate is invalid, or Caddy logs "challenge failed" | DNS does not point at the server yet, or ports 80/443 are closed in the Azure network rules. |
| Sign-in page loads but every action fails | The web app was built with different domains than `.env` now has. Rebuild with `up -d --build`. |
| `provision` exits 1 | `DATABASE_URL` or `APP_DB_PASSWORD` is missing or wrong; see `docker compose logs provision`. |
| Sign-up returns 500 | The `routenorth_app` grants are missing (database set up by hand). Rerun `provision`. |
| Build fails with a certificate error | The network inspects HTTPS traffic (common on office networks). Build on the VM instead. |
