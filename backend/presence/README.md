# Ember online presence

A small Node.js service counts temporary, anonymous Ember sessions. It has no database, account system, external dependencies, or request logging. Use one service instance; multiple independent replicas would each report only their own sessions.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Readiness check; does not register a session |
| GET | `/v1/online` | Current aggregate count |
| POST | `/v1/heartbeat` | Register or refresh a session |
| DELETE | `/v1/session` | Remove a session on a best-effort app exit |

Write requests use `Content-Type: application/json` and exactly one JSON field, `sessionId`, containing a random UUID v4. A successful presence response contains `online`, `ttlSeconds: 90`, and an ISO `serverTime`. No session IDs are returned. Responses are never cached.

Clients send a heartbeat every 30 seconds. Repeated heartbeats renew the same session instead of increasing the count. Sessions stop counting after 90 seconds without a heartbeat. IDs are newly generated on each app process launch and never saved to disk. The service retains session IDs and expiration times only in memory; it does not store names, profiles, games, mod lists, or IP addresses. Hosting providers can retain their own network and operational logs.

The count estimates active app sessions, not verified unique people. Custom clients can send fabricated heartbeats. A bounded session map, small request limit, per-session cooldown, and socket timeouts limit resource use; this is not an identity or authentication service. Restarts clear temporary sessions, which active clients register again on their next heartbeat.

## Run locally

Use Node.js 22.12 or newer:

```powershell
npm ci
npm start
```

The service binds to `0.0.0.0` and the `PORT` environment variable, defaulting to `10000`. Production traffic must use the host's HTTPS endpoint. Desktop code never accepts a renderer-supplied service URL.

## Deploy on Render

The repository's `render.yaml` defines a free web service with this directory as its root, `npm ci --omit=dev` as its build command, `npm start` as its start command, and `/health` as its health check. Review the service plan before applying it. No keys or runtime secrets are required.

For direct service creation without a root-directory field, use these repository-root commands instead:

```text
Build: npm --prefix backend/presence ci --omit=dev
Start: node backend/presence/server.cjs
```

Set `NODE_VERSION=24`. After deployment is live and verified, put the returned HTTPS origin in `package.json` as `emberPresence.endpoint`, test the client against it, and publish a new desktop version. Never guess a service URL or embed hosting credentials in the client.

Render's free instances can sleep when there is no inbound traffic. The first client may briefly show a connecting or unavailable state during startup; later heartbeats retry automatically. See [Render's free service documentation](https://render.com/docs/free) for current limits. This endpoint should receive traffic for real open clients only, without synthetic keep-alive jobs.
