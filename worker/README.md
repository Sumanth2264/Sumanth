# CinePing alert backend

Free-tier-ready Cloudflare Workers + D1 + Brevo backend for CinePing.

The Worker is provider-neutral: /api/provider-events accepts normalized show events from an authorised/permissioned provider feed. Keep BREVO_API_KEY and INGEST_SECRET as Worker secrets.

Do not use this worker to bypass robots, anti-bot controls, or terms of a provider.