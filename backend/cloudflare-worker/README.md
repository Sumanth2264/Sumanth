# CinePing free backend

Use Cloudflare Workers + D1 + Brevo.

Free limits currently documented by the providers:
- Cloudflare Workers Free: 100,000 requests/day.
- Cloudflare D1 Free: 5 million rows read/day, 100,000 rows written/day, 5 GB storage.
- Brevo Free: 300 email sends/day.

These are free-tier limits, not an unlimited service.

Setup:
1. Create a Cloudflare account and stay on the Workers Free plan.
2. Create a D1 database named cineping.
3. Run schema.sql on the database.
4. Put the database ID in wrangler.jsonc.
5. Add Worker secrets: BREVO_API_KEY, BREVO_FROM_EMAIL, INGEST_SECRET.
6. Deploy the Worker and copy its HTTPS URL.
7. Configure the CinePing website to use that URL.
8. Only connect an authorised movie/showtime feed to /ingest or CHECK_FEED_URL.

Do not scrape or bypass protections on District or BookMyShow. Live data should come from a feed/API you are authorised to use.
