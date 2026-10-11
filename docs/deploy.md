# Deploying to a server

One Linux server runs everything: Caddy (HTTPS), the web app, the API, PostGIS and MinIO.
Only Caddy is reachable from outside. This is what a phone needs: **Safari allows the
camera and GPS only on an HTTPS page**, and on a real drive the phone is on mobile data,
so the app must be on a public address.

Verified locally end to end (`DOMAIN=localhost`): HTTPS, the isolated drive page, a
drive session, a sighting, its photo uploaded to storage and read back through Caddy.

## What you need

- A Linux server with Docker and the Compose plugin. 2 GB RAM is enough for a demo;
  4 GB is comfortable. Ports **80 and 443** open.
- A domain with **two** DNS A records pointing at the server:
  `potholes.example.com` and `s3.potholes.example.com`. Evidence photos are served from
  the second name, because their signed links cover the host they were signed for.
- The exported model. It is **not in Git**, so copy it from a machine that has it:

  ```bash
  scp apps/web/public/models/model.json \
      apps/web/public/models/pothole-road-anomaly-1.0.0.onnx \
      server:~/pothole/apps/web/public/models/
  ```

  The web image refuses to build without `model.json`, rather than shipping a drive page
  that silently falls back to the synthetic detector.

## Start it

```bash
umask 077 && cat > .env.prod <<ENV   # never commit it; .gitignore already excludes it
DOMAIN=potholes.example.com
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MINIO_ROOT_USER=pothole-storage
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
ENV
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
curl https://potholes.example.com/api/health
```

`/api/health` answers `{"status":"ok","environment":"production","auth":"required"}`.
Migrations run when the API container starts. The storage bucket is created on first
start. Certificates are issued on first request and renewed by Caddy.

### Accounts, or none

`ENVIRONMENT=production` requires a sign-in. Create the first account:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec api \
  python -m app.cli create-user --email you@example.com --name "You" --role admin
```

For a **hackathon demo with no accounts**, set both `ENVIRONMENT=demo` and
`AUTH_DISABLED=true` in `.env.prod`. The API refuses to start with `AUTH_DISABLED=true`
under `production` - that guard is deliberate. With it off, **anyone who has the address
can upload sightings and change statuses**, and the console shows no sign-in at all.

Optional demo data: `... exec api python -m app.cli seed-demo`.

The Telegram bot is optional and parked: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and
`TELEGRAM_WEBHOOK_SECRET` in `.env.prod` turn it on.

## On the iPhone

1. Open `https://potholes.example.com/drive` in **Safari**, on Wi-Fi the first time - the
   model is about 50 MB and is kept on the phone after that.
2. Optionally Share > Add to Home Screen, which also makes iOS keep the model longer.
3. **Detector panel**: Runtime should read **WebGPU**. `WASM (CPU)` works but is slow;
   note the FPS in the HUD.
4. Turn **rotation lock off**, mount the phone **sideways** with the bonnet out of shot.
   The page warns if the picture arrives portrait.
5. Start the drive while parked; allow Camera and Location. Keep Safari in front and the
   phone on a charger, out of direct sun - heat throttles the GPU.
6. Stop the drive after parking. Sightings made without signal stay on the phone and
   upload, with the drive's real start and end times, when signal returns.

If accounts are on and the phone is not signed in, the drive page says **Sign in to
upload** and keeps every sighting until you do.

## Testing from your Mac before the server exists

A tunnel gives the local dev stack a temporary public HTTPS address:

```bash
cloudflared tunnel --url http://localhost:3000
```

Open the printed `https://...trycloudflare.com/drive` on the phone. The API is reached
through the web app, so this one tunnel carries sightings.

Photos need storage reachable too. **Do not tunnel the dev MinIO as it is**: it runs with
the default `minioadmin` credentials, and a public tunnel would let anyone read or delete
every object. Without it, sightings upload and their photos do not.

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

A new model ships under a new file name (`name-version.onnx`); phones fetch it once and
keep it. Back up the `postgres-data` and `minio-data` volumes before anything risky.

## On a host that already runs nginx

pitstop.mardonjon.me shares a server whose nginx and certbot own ports 80 and 443, so Caddy
stays off and nginx serves the site and its storage on one origin:

```bash
DEPLOY_HOST=root@<server-ip> infra/server/deploy.sh      # sync, build, start
.venv/bin/python -m ai.samples --api https://pitstop.mardonjon.me --reuse   # sample analyses
```

- `deploy.sh` creates `/opt/pitstop/.env.prod` on the server once (mode 600) and installs the
  nginx site and certificate on the first run.
- Storage is proxied under `/pothole-evidence`, so photos, overlays and videos are same-origin.
- The official MinIO image is no longer published; `infra/server/docker-compose.server.yml`
  pins Bitnami's build of the same release.
