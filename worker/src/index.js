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

const DISTRICT_MOVIES_URL = "https://api.parse.bot/scraper/9dbc34b2-b7c3-4e9b-9540-6d2bb2568c57/get_movies_in_theaters";
const DISTRICT_SHOWTIMES_URL = "https://api.parse.bot/scraper/9dbc34b2-b7c3-4e9b-9540-6d2bb2568c57/get_movie_showtimes";

function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function districtHeaders(env) {
  return {
    "accept": "application/json",
    "x-api-key": env.PARSE_API_KEY
  };
}

async function districtGet(url, params, env) {
  const qs = new URLSearchParams(params);
  const r = await fetch(url + "?" + qs.toString(), {
    method: "GET",
    headers: districtHeaders(env),
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  const textBody = await r.text();
  let data = {};
  try { data = JSON.parse(textBody); } catch {}
  if (!r.ok) throw new Error("District feed returned " + r.status);
  return data;
}

async function fetchDistrictShows(env) {
  if (!env.PARSE_API_KEY || !env.DB) return { configured: false, shows: [] };

  const all = await env.DB.prepare("SELECT * FROM alerts WHERE status='active'").all();
  const alerts = all.results || [];
  if (!alerts.length) return { configured: true, shows: [] };

  const groups = new Map();
  for (const alert of alerts) {
    const city = String(alert.city || "").trim();
    const movie = String(alert.movie || "").trim();
    if (!city || !movie) continue;
    const key = city.toLowerCase() + "|" + normalizeTitle(movie);
    if (!groups.has(key)) groups.set(key, { city, movie });
  }

  const shows = [];

  for (const group of groups.values()) {
    const moviesData = await fetchDistrictMoviesCached(env, group.city);
    const movies = Array.isArray(moviesData.movies)
      ? moviesData.movies
      : Array.isArray(moviesData?.data?.movies) ? moviesData.data.movies : [];

    const wanted = normalizeTitle(group.movie);
    const movie = movies.find(m =>
      normalizeTitle(m.title || m.name) === wanted
    ) || movies.find(m =>
      normalizeTitle(m.title || m.name).includes(wanted) ||
      wanted.includes(normalizeTitle(m.title || m.name))
    );

    if (!movie) continue;

    const movieId = movie.movie_id || movie.id;
    if (!movieId) continue;

    const detail = await districtGet(
      DISTRICT_SHOWTIMES_URL,
      { movie_id: String(movieId), city: group.city },
      env
    );

    const theatres = Array.isArray(detail.theatres)
      ? detail.theatres
      : Array.isArray(detail?.data?.theatres) ? detail.data.theatres : [];

    const showDates = Array.isArray(detail.show_dates)
      ? detail.show_dates
      : Array.isArray(detail?.data?.show_dates) ? detail.data.show_dates : [];

    for (const theatre of theatres) {
      const theatreName = theatre.name || theatre.theatre_name || "";
      const slots = Array.isArray(theatre.showtimes)
        ? theatre.showtimes
        : Array.isArray(theatre.shows) ? theatre.shows : [];

      for (const slot of slots) {
        const date = slot.date || detail.date || showDates[0] || "";
        const time = slot.time || slot.show_time || slot.start_time || "";
        const formats = [slot.screen_format, slot.format, slot.auditorium_format].filter(Boolean).map(String);
        const languages = [slot.language, slot.lang].filter(Boolean).map(String);
        const bookingUrl = slot.booking_url || slot.bookingUrl || slot.book_now_url || theatre.booking_url || "";

        shows.push({
          movie: movie.title || group.movie,
          city: group.city,
          theatre: theatreName,
          date,
          time,
          formats,
          languages,
          source: "District",
          bookingUrl,
          isFdfs: Boolean(slot.is_fdfs || slot.isFdfs),
          isReleaseDay: Boolean(slot.is_release_day || slot.isReleaseDay)
        });
      }
    }
  }

  return { configured: true, shows };
}

async function ensureMonitorTables(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS monitor_state (id INTEGER PRIMARY KEY CHECK(id=1), last_run_at TEXT, last_success_at TEXT, next_run_at TEXT, checked INTEGER DEFAULT 0, sent INTEGER DEFAULT 0)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS district_movie_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL)"
  ).run();
}

async function getMonitorState(env) {
  await ensureMonitorTables(env);
  return await env.DB.prepare("SELECT * FROM monitor_state WHERE id=1").first();
}

async function setMonitorState(env, patch) {
  await ensureMonitorTables(env);
  const current = await getMonitorState(env) || { last_run_at:null, last_success_at:null, next_run_at:null, checked:0, sent:0 };
  const merged = { ...current, ...patch };
  await env.DB.prepare(
    "INSERT INTO monitor_state(id,last_run_at,last_success_at,next_run_at,checked,sent) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at,last_success_at=excluded.last_success_at,next_run_at=excluded.next_run_at,checked=excluded.checked,sent=excluded.sent"
  ).bind(
    merged.last_run_at, merged.last_success_at, merged.next_run_at,
    Number(merged.checked || 0), Number(merged.sent || 0)
  ).run();
}

function parseStoredTime(value) {
  const direct = Date.parse(String(value || ""));
  if (Number.isFinite(direct)) return direct;
  const utc = Date.parse(String(value || "") + "Z");
  return Number.isFinite(utc) ? utc : NaN;
}

function monitorIntervalMinutes(env) {
  const n = Number(env.MONITOR_INTERVAL_MINUTES || 360);
  return Number.isFinite(n) && n >= 5 ? Math.floor(n) : 360;
}

async function fetchDistrictMoviesCached(env, city) {
  const key = String(city || "").toLowerCase();
  const cached = await env.DB.prepare("SELECT payload,fetched_at FROM district_movie_cache WHERE cache_key=?").bind(key).first();
  const age = cached?.fetched_at ? Date.now() - Date.parse(cached.fetched_at + "Z") : Infinity;
  if (cached && Number.isFinite(age) && age < 86400000) {
    try { return JSON.parse(cached.payload); } catch {}
  }

  const data = await districtGet(DISTRICT_MOVIES_URL, { city }, env);
  await env.DB.prepare(
    "INSERT INTO district_movie_cache(cache_key,payload,fetched_at) VALUES(?,?,datetime('now')) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at"
  ).bind(key, JSON.stringify(data)).run();
  return data;
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
      return json(env, { ok: true, service: "cineping-alert-api", version: "2026-09-26-district-v2", d1: !!env.DB, mailConfigured: !!(env.BREVO_API_KEY && env.BREVO_FROM_EMAIL), districtConfigured: !!env.PARSE_API_KEY, schedulerConfigured: !!(env.PARSE_API_KEY || env.SHOWTIME_FEED_URL) });
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

    if (u.pathname === "/api/monitor-status" && req.method === "GET") {
      try {
        const state = await getMonitorState(env);
        return json(env, {
          ok: true,
          districtConfigured: !!env.PARSE_API_KEY,
          intervalMinutes: monitorIntervalMinutes(env),
          state: state || null
        });
      } catch {
        return json(env, { error: "monitor status unavailable" }, 500);
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
      if (!env.DB) return;
      const now = new Date();
      const nowIso = now.toISOString();
      try {
        const state = await getMonitorState(env);
        if (state?.next_run_at && parseStoredTime(state.next_run_at) > now.getTime()) return;

        await setMonitorState(env, { last_run_at: nowIso, next_run_at: new Date(now.getTime() + monitorIntervalMinutes(env) * 60000).toISOString().replace("Z","") });

        const district = await fetchDistrictShows(env);
        if (!district.configured) return;

        const result = await processShows(env, district.shows);
        await setMonitorState(env, {
          last_success_at: new Date().toISOString().replace("Z",""),
          checked: result.checked,
          sent: result.sent,
          next_run_at: new Date(Date.now() + monitorIntervalMinutes(env) * 60000).toISOString().replace("Z","")
        });
      } catch (err) {
        await setMonitorState(env, {
          next_run_at: new Date(Date.now() + 15 * 60000).toISOString().replace("Z","")
        });
      }
    })());
  }
};