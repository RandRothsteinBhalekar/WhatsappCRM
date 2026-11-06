# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with:

- **`db`** — PostgreSQL 17
- **`app`** — the Next.js CRM

Media files are stored on a Docker volume (`wacrm_media`) mounted at
`MEDIA_ROOT` (`/data/media` in the container).

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

   Set at least `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`,
   and `META_APP_SECRET`. For Compose networking use:

   ```bash
   DATABASE_URL=postgres://wacrm:wacrm@db:5432/wacrm
   ```

2. Start Postgres, apply migrations, then the app:

   ```bash
   docker compose --env-file .env.local up db -d
   # From the host (with DATABASE_URL pointing at localhost:5432):
   npm run db:migrate
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild.
- Everything else (`DATABASE_URL`, `BETTER_AUTH_SECRET`,
  `ENCRYPTION_KEY`, `META_APP_SECRET`, …) is read at **runtime** from
  `.env.local` via `env_file`.

## Notes

- Database migrations under `db/migrations/` are applied with
  `npm run db:migrate` (not by the app container).
- Received attachments are copied into `chat-media` under `MEDIA_ROOT`.
- Automation / flow Wait steps need an external scheduler hitting
  `/api/automations/cron` and `/api/flows/cron` with `x-cron-secret`.
