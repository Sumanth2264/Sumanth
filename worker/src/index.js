const ALLOWED_ORIGIN = "https://sumanth2264.github.io";
const jsonHeaders = (env, origin = ALLOWED_ORIGIN) => ({
  "content-type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "content-type,x-ingest-secret",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Vary": "Origin"
});

const json = (env, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: jsonHeaders(env) });

const esc = (s) =>
  String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function send(env, to, subject, html) {
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { email: env.BREVO_FROM_EMAIL, name: env.BREVO_FROM_NAME || "CinePing" },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
  if (!r.ok) {
    throw new Error("Brevo send failed");
  }
}

function sourcesFromAlert(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value || "Any").split(",").map((x) => x.trim()).filter(Boolean);
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function normalizeTimeToMinutes(value) {
  const m = String(value || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = Number(m[1]), min = Number(m[2]);
  const ap = (m[3] || "").toUpperCase();
  if (ap === "AM" && h === 12) h = 0;
  if (ap === "PM" && h < 12) h += 12;
  return h * 60 + min;
}

function matchDatePreference(alert, show) {
  const pref = String(alert.date_pref || "Any date");
  if (pref === "Any date") return true;
  if (pref === "Specific date") return !alert.specific_date || alert.specific_date === show.date;
  if (pref === "Release day") return show.isReleaseDay === true;
  if (pref === "Next day") {
    const now = new Date();
    const d = new Date(String(show.date || "") + "T00:00:00Z");
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return !Number.isNaN(d.getTime()) && Math.round((d - today) / 86400000) === 1;
  }
  if (pref === "This weekend") {
    if (show.isWeekend === true) return true;
    const d = new Date(String(show.date || "") + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && [0, 6].includes(d.getUTCDay());
  }
  return true;
}

function matchTimePreference(alert, show) {
  const pref = String(alert.time_pref || "Any time");
  if (pref === "Any time") return true;
  if (pref === "FDFS only") return show.isFdfs === true;
  const mins = normalizeTimeToMinutes(show.time);
  if (mins === null) return true;
  if (pref === "Morning · 6–12") return mins >= 360 && mins < 720;
  if (pref === "Afternoon · 12–5") return mins >= 720 && mins < 1020;
  if (pref === "Evening · 5–10") return mins >= 1020 && mins < 1320;
  if (pref === "Late night · 10+") return mins >= 1320 || mins < 360;
  return true;
}

function match(alert, show) {
  if (alert.city && alert.city.toLowerCase() !== String(show.city || "").toLowerCase()) return false;
  if (alert.movie && alert.movie.toLowerCase() !== String(show.movie || "").toLowerCase()) return false;

  const theatres = parseJsonArray(alert.theatres);
  if (theatres.length && !theatres.some((x) => String(x).toLowerCase() === String(show.theatre || "").toLowerCase())) return false;

  if (alert.language && alert.language !== "Any" &&
      !(show.languages || []).some((x) => String(x).toLowerCase() === String(alert.language).toLowerCase())) return false;
  if (alert.format && alert.format !== "Any" &&
      !(show.formats || []).some((x) => String(x).toLowerCase() === String(alert.format).toLowerCase())) return false;
  if (!matchDatePreference(alert, show)) return false;
  if (!matchTimePreference(alert, show)) return false;

  const wantedSources = sourcesFromAlert(alert.source);
  if (wantedSources.length && wantedSources[0] !== "Any" && show.source && !wantedSources.includes(show.source)) return false;
  return true;
}

async function processShows(env, shows) {
  if (!env.DB || !Array.isArray(shows) || !shows.length) return { sent: 0, checked: 0 };
  const all = await env.DB.prepare("SELECT * FROM alerts WHERE status='active'").all();
  const alerts = all.results || [];
  let sent = 0, checked = 0;

  for (const show of shows) {
    checked++;
    for (const alert of alerts) {
      if (!match(alert, show)) continue;

      const key = [
        alert.id, show.source || "", show.bookingUrl || "", show.movie || "",
        show.theatre || "", show.date || "", show.time || "",
        (show.languages || []).join(","), (show.formats || []).join(",")
      ].join("|");

      const exists = await env.DB.prepare("SELECT id FROM deliveries WHERE dedupe_key=?").bind(key).first();
      if (exists) continue;

      try {
        await send(
          env,
          alert.email,
          "Tickets live · " + show.movie + " · " + show.theatre,
          "<p><strong>Tickets are live.</strong></p>" +
          "<p>" + esc(show.movie) + " · " + esc(show.theatre) + " · " + esc(show.date) + " · " + esc(show.time) + "</p>" +
          "<p>Language: " + esc((show.languages || []).join(", ")) +
          "<br>Format: " + esc((show.formats || []).join(", ")) +
          "<br>Source: " + esc(show.source || "Official provider") + "</p>" +
          (show.bookingUrl ? "<p><a href='" + esc(show.bookingUrl) + "'>Open official booking page →</a></p>" : "")
        );
        await env.DB.prepare(
          "INSERT INTO deliveries(id,alert_id,dedupe_key,delivered_at) VALUES(?,?,?,datetime('now'))"
        ).bind(crypto.randomUUID(), alert.id, key).run();
        sent++;
      } catch {
        // Leave undelivered so the next poll can retry.
      }
    }
  }
  return { sent, checked };
}

async function fetchConfiguredFeed(env) {
  if (!env.SHOWTIME_FEED_URL) return { configured: false, shows: [] };
  const headers = {};
  if (env.SHOWTIME_FEED_TOKEN) headers.authorization = "Bearer " + env.SHOWTIME_FEED_TOKEN;
  const r = await fetch(env.SHOWTIME_FEED_URL, {
    method: "GET",
    headers,
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  if (!r.ok) throw new Error("showtime feed returned " + r.status);
  const data = await r.json();
  if (Array.isArray(data)) return { configured: true, shows: data };
  if (Array.isArray(data.shows)) return { configured: true, shows: data.shows };
  throw new Error("showtime feed must return shows[]");
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      const origin = req.headers.get("Origin") || "";
      return new Response(null, {
        status: 204,
        headers: {
          ...jsonHeaders(env, origin),
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const u = new URL(req.url);

    if (u.pathname === "/api/health" && req.method === "GET") {
      return json(env, { ok: true, service: "cineping-alert-api", version: "2026-09-26-monitor-v1", d1: !!env.DB, mailConfigured: !!(env.BREVO_API_KEY && env.BREVO_FROM_EMAIL), schedulerConfigured: !!env.SHOWTIME_FEED_URL });
    }

    if (u.pathname === "/api/alerts" && req.method === "POST") {
      try {
        const b = await req.json();
        const email = String(b.email || "").trim().toLowerCase();
        const movie = String(b.movie || "").trim();

        if (!email || !movie) return json(env, { error: "email and movie are required" }, 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(env, { error: "valid email required" }, 400);

        const id = crypto.randomUUID();
        const token = crypto.randomUUID() + crypto.randomUUID();

        await env.DB.prepare(
          "INSERT INTO alerts(id,email,movie,city,theatres,language,format,time_pref,source,status,manage_token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))"
        ).bind(
          id,
          email,
          movie,
          String(b.city || ""),
          JSON.stringify(Array.isArray(b.theatres) ? b.theatres : []),
          String(b.language || "Any"),
          String(b.format || "Any"),
          String(b.time || "Any time"),
          JSON.stringify(Array.isArray(b.sources) && b.sources.length ? b.sources : ["Any"]),
          "active",
          token
        ).run();

        let emailSent = false;
        try {
          await send(
            env,
            email,
            "CinePing alert armed · " + movie,
            "<p>Your CinePing alert for <strong>" + esc(movie) + "</strong> in <strong>" +
            esc(b.city || "India") + "</strong> is active.</p>" +
            "<p>Selected theatres: " + esc((b.theatres || []).join(", ") || "Any matching theatre") + ".</p>" +
            "<p>When an authorised showtime feed matches your rule, CinePing will email you with the official booking page.</p>"
          );
          emailSent = true;
        } catch {
          // The alert is intentionally kept in D1 even if the confirmation email fails.
          // This lets the user continue while email configuration is diagnosed separately.
        }

        return json(env, { ok: true, id, emailSent }, 201);
      } catch (e) {
        return json(env, { error: "could not create alert" }, 500);
      }
    }

    if (u.pathname === "/api/provider-events" && req.method === "POST") {
      if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) return json(env, { error: "unauthorized" }, 401);
      try {
        const b = await req.json();
        if (!Array.isArray(b.shows)) return json(env, { error: "shows[] required" }, 400);
        const result = await processShows(env, b.shows);
        return json(env, { ok: true, ...result });
      } catch {
        return json(env, { error: "ingest failed" }, 500);
      }
    }

    return json(env, { error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const feed = await fetchConfiguredFeed(env);
        if (!feed.configured) return;
        await processShows(env, feed.shows);
      } catch {
        // Retry automatically on the next scheduled run.
      }
    })());
  }
};