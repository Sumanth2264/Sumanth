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

function match(alert, show) {
  if (alert.city && alert.city.toLowerCase() !== String(show.city || "").toLowerCase()) return false;
  if (alert.movie && alert.movie.toLowerCase() !== String(show.movie || "").toLowerCase()) return false;

  const theatres = JSON.parse(alert.theatres || "[]");
  if (theatres.length && !theatres.some((x) => x.toLowerCase() === String(show.theatre || "").toLowerCase())) return false;

  if (alert.language && alert.language !== "Any" && !(show.languages || []).includes(alert.language)) return false;
  if (alert.format && alert.format !== "Any" && !(show.formats || []).includes(alert.format)) return false;
  if (alert.time_pref === "FDFS only" && !show.isFdfs) return false;

  const wantedSources = sourcesFromAlert(alert.source);
  if (wantedSources.length && wantedSources[0] !== "Any" && show.source && !wantedSources.includes(show.source)) return false;

  return true;
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
      return json(env, { ok: true, service: "cineping-alert-api", d1: !!env.DB, mailConfigured: !!(env.BREVO_API_KEY && env.BREVO_FROM_EMAIL) });
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

        await send(
          env,
          email,
          "CinePing alert armed · " + movie,
          "<p>Your CinePing alert for <strong>" + esc(movie) + "</strong> in <strong>" +
          esc(b.city || "India") + "</strong> is active.</p>" +
          "<p>Selected theatres: " + esc((b.theatres || []).join(", ") || "Any matching theatre") + ".</p>" +
          "<p>When an authorised showtime feed matches your rule, CinePing will email you with the official booking page.</p>"
        );

        return json(env, { ok: true, id }, 201);
      } catch (e) {
        return json(env, { error: "could not create alert" }, 500);
      }
    }

    if (u.pathname === "/api/provider-events" && req.method === "POST") {
      if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) {
        return json(env, { error: "unauthorized" }, 401);
      }

      try {
        const b = await req.json();
        if (!Array.isArray(b.shows)) return json(env, { error: "shows[] required" }, 400);

        const all = await env.DB.prepare("SELECT * FROM alerts WHERE status='active'").all();
        let sent = 0;

        for (const show of b.shows) {
          for (const alert of (all.results || [])) {
            if (!match(alert, show)) continue;

            const key = alert.id + "|" + (show.source || "") + "|" + (show.bookingUrl || "") + "|" + show.date + "|" + show.time;
            const exists = await env.DB.prepare("SELECT id FROM deliveries WHERE dedupe_key=?").bind(key).first();
            if (exists) continue;

            await send(
              env,
              alert.email,
              "Tickets live · " + show.movie + " · " + show.theatre,
              "<p><strong>Tickets are live.</strong></p>" +
              "<p>" + esc(show.movie) + " · " + esc(show.theatre) + " · " +
              esc(show.date) + " · " + esc(show.time) + "</p>" +
              "<p>Language: " + esc((show.languages || []).join(", ")) +
              "<br>Format: " + esc((show.formats || []).join(", ")) +
              "<br>Source: " + esc(show.source || "Official provider") + "</p>" +
              (show.bookingUrl ? "<p><a href='" + esc(show.bookingUrl) + "'>Open official booking page →</a></p>" : "")
            );

            await env.DB.prepare(
              "INSERT INTO deliveries(id,alert_id,dedupe_key,delivered_at) VALUES(?,?,?,datetime('now'))"
            ).bind(crypto.randomUUID(), alert.id, key).run();

            sent++;
          }
        }

        return json(env, { ok: true, sent });
      } catch {
        return json(env, { error: "ingest failed" }, 500);
      }
    }

    return json(env, { error: "not found" }, 404);
  }
};
