# ROADMAP — deferred / non-MVP items

Anything not required for the MVP goes here instead of becoming a placeholder
in the code. Items move out of this file only with explicit user approval.

## Storage

- S3/MinIO upload driver (`STORAGE_DRIVER=s3`); local volume stays default.
- CDN/cache headers for served uploads.

## Voice / media

- `network_mode: host` compose override for Linux production LiveKit.
- TURN/TLS on port 443 (no-LB setups) and TURN/UDP on 443 experiments.
- Redis for LiveKit in multi-node setups (single node needs none).
- Transcoding / recording / egress (LiveKit Egress) — out of MVP.
- Krisp-like third-party noise suppression — evaluate license if RNNoise path fails.

## Data model

- `voice_sessions` audit table (joins/leaves/mutes history).
- Channel-level permission overrides (MVP: role flags only).
- Full-text search index for messages (trigram/FTS).
- Custom roles beyond owner/admin/member.

## Product

- Multi-server UI (schema supports several; MVP UI uses one).
- Mobile native apps; rich embeds; threads; reactions (post-MVP features).
- Smaller Docker images (multi-stage prune, non-root hardening pass).

## Ops

- Automated backup cron + restore runbook testing.
- Prometheus metrics endpoint + Grafana dashboard.
- Upgrade notes per release.
