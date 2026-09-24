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
  if (alert.city && normalizeTitle(alert.city) !== normalizeTitle(show.city)) return false;
  if (alert.movie && normalizeTitle(alert.movie) !== normalizeTitle(show.movie)) return false;

  const theatres = parseJsonArray(alert.theatres);
  if (theatres.length && !theatres.some((x) => { const a=normalizeTitle(x), b=normalizeTitle(show.theatre); return a===b || a.includes(b) || b.includes(a); })) return false;

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

const MONTHLY_CREDIT_CAP = 190;
const MAX_SHOWTIME_CALLS_PER_TARGET = 7;
const CREATION_BURST_CALLS = 4;
const BURST_INTERVAL_MINUTES = 5;
const NEAR_DATE_INTERVAL_MINUTES = 360;
const NORMAL_INTERVAL_MINUTES = 2880;
const MOVIE_CACHE_HOURS = 168;

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function isoNoZ(date) {
  return new Date(date).toISOString().replace("Z", "");
}

function parseStoredTime(value) {
  const direct = Date.parse(String(value || ""));
  if (Number.isFinite(direct)) return direct;
  const utc = Date.parse(String(value || "") + "Z");
  return Number.isFinite(utc) ? utc : NaN;
}

function districtHeaders(env) {
  return {
    "accept": "application/json",
    "x-api-key": env.PARSE_API_KEY
  };
}

async function ensureMonitorTables(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS monitor_state (id INTEGER PRIMARY KEY CHECK(id=1), last_run_at TEXT, last_success_at TEXT, next_run_at TEXT, checked INTEGER DEFAULT 0, sent INTEGER DEFAULT 0)").run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS monitor_usage (month TEXT PRIMARY KEY, credits_used INTEGER NOT NULL DEFAULT 0, catalog_calls INTEGER NOT NULL DEFAULT 0, showtime_calls INTEGER NOT NULL DEFAULT 0)"
  ).run();

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS monitor_targets (target_key TEXT PRIMARY KEY, city TEXT NOT NULL, movie TEXT NOT NULL, date_pref TEXT NOT NULL DEFAULT 'Any date', specific_date TEXT NOT NULL DEFAULT '', movie_id TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, next_poll_at TEXT NOT NULL, burst_remaining INTEGER NOT NULL DEFAULT 0, usage_month TEXT NOT NULL DEFAULT '', showtime_calls_month INTEGER NOT NULL DEFAULT 0, last_polled_at TEXT, last_success_at TEXT, last_match_at TEXT)"
  ).run();

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS district_movie_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL)"
  ).run();

  try {
    await env.DB.prepare("ALTER TABLE alerts ADD COLUMN date_pref TEXT DEFAULT 'Any date'").run();
  } catch {}
  try {
    await env.DB.prepare("ALTER TABLE alerts ADD COLUMN specific_date TEXT DEFAULT ''").run();
  } catch {}

  await env.DB.prepare(
    "INSERT OR IGNORE INTO monitor_usage(month,credits_used,catalog_calls,showtime_calls) VALUES(?,0,0,0)"
  ).bind(monthKey()).run();
}

async function getMonitorState(env) {
  await ensureMonitorTables(env);
  return env.DB.prepare(
    "SELECT * FROM monitor_state WHERE id=1"
  ).first();
}

async function setMonitorState(env, patch) {
  await ensureMonitorTables(env);
  const current = await getMonitorState(env) || {
    last_run_at: null,
    last_success_at: null,
    next_run_at: null,
    checked: 0,
    sent: 0
  };

  const merged = { ...current, ...patch };

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS monitor_state (id INTEGER PRIMARY KEY CHECK(id=1), last_run_at TEXT, last_success_at TEXT, next_run_at TEXT, checked INTEGER DEFAULT 0, sent INTEGER DEFAULT 0)"
  ).run();

  await env.DB.prepare(
    "INSERT INTO monitor_state(id,last_run_at,last_success_at,next_run_at,checked,sent) VALUES(1,?,?,?,?,?) " +
    "ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at,last_success_at=excluded.last_success_at,next_run_at=excluded.next_run_at,checked=excluded.checked,sent=excluded.sent"
  ).bind(
    merged.last_run_at,
    merged.last_success_at,
    merged.next_run_at,
    Number(merged.checked || 0),
    Number(merged.sent || 0)
  ).run();
}

async function getUsage(env) {
  await ensureMonitorTables(env);
  return await env.DB.prepare("SELECT * FROM monitor_usage WHERE month=?")
    .bind(monthKey()).first();
}

async function reserveCredits(env, cost, kind) {
  await ensureMonitorTables(env);
  const month = monthKey();
  const r = await env.DB.prepare(
    "UPDATE monitor_usage SET credits_used=credits_used+?, " +
    "catalog_calls=catalog_calls+CASE WHEN ?='catalog' THEN 1 ELSE 0 END, " +
    "showtime_calls=showtime_calls+CASE WHEN ?='showtime' THEN 1 ELSE 0 END " +
    "WHERE month=? AND credits_used+?<=?"
  ).bind(cost, kind, kind, month, cost, MONTHLY_CREDIT_CAP).run();
  return Number(r.meta?.changes || 0) === 1;
}

async function releaseCredits(env, cost, kind) {
  const sql = kind === "catalog"
    ? "UPDATE monitor_usage SET credits_used=MAX(0,credits_used-?),catalog_calls=MAX(0,catalog_calls-1) WHERE month=?"
    : "UPDATE monitor_usage SET credits_used=MAX(0,credits_used-?),showtime_calls=MAX(0,showtime_calls-1) WHERE month=?";
  await env.DB.prepare(sql).bind(cost, monthKey()).run();
}

async function districtGet(url, params, env, kind, cost) {
  const reserved = await reserveCredits(env, cost, kind);
  if (!reserved) throw new Error("CinePing monthly District budget reached");

  try {
    const qs = new URLSearchParams(params);
    const r = await fetch(url + "?" + qs.toString(), {
      method: "GET",
      headers: districtHeaders(env),
      cf: { cacheTtl: 0, cacheEverything: false }
    });

    const body = await r.text();
    let data = {};
    try { data = JSON.parse(body); } catch {}

    if (!r.ok) {
      await releaseCredits(env, cost, kind);
      throw new Error("District feed returned " + r.status);
    }
    return data;
  } catch (e) {
    if (e?.message === "CinePing monthly District budget reached") throw e;
    await releaseCredits(env, cost, kind);
    throw e;
  }
}

async function fetchDistrictMoviesCached(env, city, force = false) {
  const key = String(city || "").toLowerCase();
  const cached = await env.DB.prepare(
    "SELECT payload,fetched_at FROM district_movie_cache WHERE cache_key=?"
  ).bind(key).first();

  const age = cached?.fetched_at
    ? Date.now() - Date.parse(cached.fetched_at + "Z")
    : Infinity;

  if (!force && cached && Number.isFinite(age) && age < MOVIE_CACHE_HOURS * 60 * 60 * 1000) {
    try { return JSON.parse(cached.payload); } catch {}
  }

  const data = await districtGet(
    DISTRICT_MOVIES_URL,
    { city },
    env,
    "catalog",
    2
  );

  await env.DB.prepare(
    "INSERT INTO district_movie_cache(cache_key,payload,fetched_at) VALUES(?,?,datetime('now')) " +
    "ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at"
  ).bind(key, JSON.stringify(data)).run();

  return data;
}

function movieList(data) {
  return Array.isArray(data?.movies)
    ? data.movies
    : Array.isArray(data?.data?.movies) ? data.data.movies : [];
}

function findMovie(data, title) {
  const wanted = normalizeTitle(title);
  const movies = movieList(data);

  return movies.find((m) =>
    normalizeTitle(m.title || m.name) === wanted
  ) || movies.find((m) => {
    const name = normalizeTitle(m.title || m.name);
    return name && (name.includes(wanted) || wanted.includes(name));
  }) || null;
}

function releaseDateFromMovie(movie) {
  const raw = Number(movie?.release_date || 0);
  if (!raw) return "";
  const ms = raw < 100000000000 ? raw * 1000 : raw;
  return new Date(ms).toISOString().slice(0, 10);
}

function nextDay(date) {
  const d = new Date(String(date || "") + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function requestedDate(alert, movie) {
  const pref = String(alert.date_pref || "Any date");
  if (pref === "Specific date" && alert.specific_date) return alert.specific_date;

  const release = releaseDateFromMovie(movie);
  if (pref === "Release day" || String(alert.time_pref || "") === "FDFS only") return release;
  if (pref === "Next day") return nextDay(release);

  return "";
}

function showtimeTheatres(detail) {
  return Array.isArray(detail?.theatres)
    ? detail.theatres
    : Array.isArray(detail?.data?.theatres)
      ? detail.data.theatres
      : [];
}

function normalizeShowSlots(detail, movie, city, releaseDate) {
  const result = [];
  for (const theatre of showtimeTheatres(detail)) {
    const theatreName = theatre.name || theatre.theatre_name || "";
    const slots = Array.isArray(theatre.showtimes)
      ? theatre.showtimes
      : Array.isArray(theatre.shows) ? theatre.shows : [];

    const derivedTimes = slots
      .map((slot) => String(slot.time || slot.show_time || slot.start_time || ""))
      .filter(Boolean)
      .sort((a, b) => {
        const am = normalizeTimeToMinutes(a) ?? 9999;
        const bm = normalizeTimeToMinutes(b) ?? 9999;
        return am - bm;
      });

    const firstTime = derivedTimes[0] || "";

    for (const slot of slots) {
      const date = String(slot.date || detail.date || "");
      const time = String(slot.time || slot.show_time || slot.start_time || "");
      const formats = [
        slot.screen_format,
        slot.format,
        slot.auditorium_format
      ].filter(Boolean).map(String);
      const languages = [
        slot.language,
        slot.lang
      ].filter(Boolean).map(String);

      const explicitFdfs = Boolean(slot.is_fdfs || slot.isFdfs);
      const derivedFdfs = Boolean(releaseDate && date === releaseDate && time && time === firstTime);

      result.push({
        movie: movie.title || movie.name || "",
        city,
        theatre: theatreName,
        date,
        time,
        formats,
        languages,
        source: "District",
        bookingUrl: slot.booking_url || slot.bookingUrl || slot.book_now_url || theatre.booking_url || "",
        availableSeats: slot.available_seats ?? slot.availableSeats ?? null,
        totalSeats: slot.total_seats ?? slot.totalSeats ?? null,
        isFdfs: explicitFdfs || derivedFdfs,
        isReleaseDay: Boolean(releaseDate && date === releaseDate),
        isWeekend: Boolean(slot.is_weekend || slot.isWeekend)
      });
    }
  }
  return result;
}

function alertTargetKey(alert) {
  const datePart =
    alert.date_pref === "Specific date" && alert.specific_date
      ? alert.specific_date
      : String(alert.date_pref || "Any date");

  return [
    String(alert.city || "").toLowerCase(),
    normalizeTitle(alert.movie),
    datePart.toLowerCase()
  ].join("|");
}

function dateDistanceDays(dateString) {
  if (!dateString) return null;
  const d = new Date(dateString + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((d - today) / 86400000);
}

async function upsertTarget(env, alert, burst = true) {
  await ensureMonitorTables(env);
  const key = alertTargetKey(alert);
  const current = await env.DB.prepare(
    "SELECT * FROM monitor_targets WHERE target_key=?"
  ).bind(key).first();

  const now = isoNoZ(new Date());
  const burstRemaining = Math.max(Number(current?.burst_remaining || 0), burst ? CREATION_BURST_CALLS : 0);

  if (!current) {
    await env.DB.prepare(
      "INSERT INTO monitor_targets(target_key,city,movie,date_pref,specific_date,movie_id,active,next_poll_at,burst_remaining,usage_month,showtime_calls_month) VALUES(?,?,?,?,?,?,1,?,?,?,0)"
    ).bind(
      key,
      alert.city || "",
      alert.movie || "",
      alert.date_pref || "Any date",
      alert.specific_date || "",
      "",
      now,
      burstRemaining,
      monthKey()
    ).run();
  } else {
    await env.DB.prepare(
      "UPDATE monitor_targets SET active=1,city=?,movie=?,date_pref=?,specific_date=?,next_poll_at=?,burst_remaining=?,usage_month=?,showtime_calls_month=CASE WHEN usage_month=? THEN showtime_calls_month ELSE 0 END WHERE target_key=?"
    ).bind(
      alert.city || current.city,
      alert.movie || current.movie,
      alert.date_pref || current.date_pref,
      alert.specific_date || current.specific_date || "",
      now,
      burstRemaining,
      monthKey(),
      monthKey(),
      key
    ).run();
  }

  return key;
}

async function loadAlertsForTarget(env, target) {
  const all = await env.DB.prepare(
    "SELECT * FROM alerts WHERE status='active' AND LOWER(city)=LOWER(?)"
  ).bind(target.city).all();

  return (all.results || []).filter((a) => alertTargetKey(a) === target.target_key);
}

async function pollTarget(env, targetKey, immediate = false) {
  await ensureMonitorTables(env);
  const target = await env.DB.prepare(
    "SELECT * FROM monitor_targets WHERE target_key=?"
  ).bind(targetKey).first();

  if (!target || !target.active || !env.PARSE_API_KEY) return { checked: 0, sent: 0, skipped: true };

  const alerts = await loadAlertsForTarget(env, target);
  if (!alerts.length) {
    await env.DB.prepare("UPDATE monitor_targets SET active=0 WHERE target_key=?").bind(targetKey).run();
    return { checked: 0, sent: 0 };
  }

  const targetAlert = alerts[0];
  const usageMonth = monthKey();
  const targetCalls = target.usage_month === usageMonth
    ? Number(target.showtime_calls_month || 0)
    : 0;

  if (targetCalls >= MAX_SHOWTIME_CALLS_PER_TARGET) {
    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
    nextMonth.setUTCHours(0, 5, 0, 0);
    await env.DB.prepare(
      "UPDATE monitor_targets SET usage_month=?,showtime_calls_month=0,next_poll_at=? WHERE target_key=?"
    ).bind(monthKey(nextMonth), isoNoZ(nextMonth), targetKey).run();
    return { checked: 0, sent: 0, skipped: true, reason: "target-month-cap" };
  }

  const movieData = await fetchDistrictMoviesCached(env, target.city, false);
  const movie = findMovie(movieData, target.movie);

  if (!movie) {
    const next = new Date(Date.now() + NORMAL_INTERVAL_MINUTES * 60000);
    await env.DB.prepare(
      "UPDATE monitor_targets SET last_polled_at=?,next_poll_at=? WHERE target_key=?"
    ).bind(isoNoZ(new Date()), isoNoZ(next), targetKey).run();
    return { checked: 0, sent: 0, reason: "movie-not-found" };
  }

  const movieId = String(movie.movie_id || movie.id || "");
  if (!movieId) return { checked: 0, sent: 0, reason: "movie-id-missing" };

  const requested = requestedDate(targetAlert, movie);
  const params = { movie_id: movieId, city: target.city };
  if (requested) params.date = requested;

  const detail = await districtGet(
    DISTRICT_SHOWTIMES_URL,
    params,
    env,
    "showtime",
    1
  );

  const shows = normalizeShowSlots(detail, movie, target.city, releaseDateFromMovie(movie));
  const result = await processShows(env, shows);

  const newCalls = targetCalls + 1;
  const burstRemaining = Math.max(0, Number(target.burst_remaining || 0) - 1);

  const dist = dateDistanceDays(requested || releaseDateFromMovie(movie));
  const priorityWindow = dist !== null && dist <= 1 && dist >= -1;
  const nearWindow = dist !== null && dist <= 3 && dist >= -3;

  let nextDelayMinutes;
  let nextBurstRemaining = burstRemaining;

  if (result.sent > 0) {
    nextDelayMinutes = 1440;
    nextBurstRemaining = 0;
  } else if (priorityWindow && burstRemaining > 0) {
    nextDelayMinutes = BURST_INTERVAL_MINUTES;
    nextBurstRemaining = Math.max(0, burstRemaining - 1);
  } else if (dist !== null && dist > 3) {
    nextDelayMinutes = dist <= 7 ? 720 : NORMAL_INTERVAL_MINUTES;
  } else if (nearWindow) {
    nextDelayMinutes = 360;
  } else if (burstRemaining > 0 && requested) {
    nextDelayMinutes = 720;
  } else {
    nextDelayMinutes = NORMAL_INTERVAL_MINUTES;
  }

  const next = new Date(Date.now() + nextDelayMinutes * 60000);
  await env.DB.prepare(
    "UPDATE monitor_targets SET movie_id=?,last_polled_at=?,last_success_at=?,last_match_at=CASE WHEN ? > 0 THEN ? ELSE last_match_at END,next_poll_at=?,burst_remaining=?,usage_month=?,showtime_calls_month=? WHERE target_key=?"
  ).bind(
    movieId,
    isoNoZ(new Date()),
    isoNoZ(new Date()),
    result.sent,
    isoNoZ(new Date()),
    isoNoZ(next),
    burstRemaining,
    usageMonth,
    newCalls,
    targetKey
  ).run();

  return { ...result, movieId, nextPollAt: isoNoZ(next) };
}

async function processDueTargets(env, limit = 1) {
  await ensureMonitorTables(env);
  const rows = await env.DB.prepare(
    "SELECT * FROM monitor_targets WHERE active=1"
  ).all();

  const now = Date.now();
  const due = (rows.results || [])
    .filter((row) => {
      const t = parseStoredTime(row.next_poll_at);
      return Number.isFinite(t) && t <= now;
    })
    .sort((a, b) => {
      const ab = Number(a.burst_remaining || 0) > 0 ? 0 : 1;
      const bb = Number(b.burst_remaining || 0) > 0 ? 0 : 1;
      if (ab !== bb) return ab - bb;

      const ad = dateDistanceDays(String(a.date_pref || "") === "Specific date" ? String(a.specific_date || "") : "");
      const bd = dateDistanceDays(String(b.date_pref || "") === "Specific date" ? String(b.specific_date || "") : "");
      if (ad !== null && bd !== null) return Math.abs(ad) - Math.abs(bd);
      return parseStoredTime(a.next_poll_at) - parseStoredTime(b.next_poll_at);
    })
    .slice(0, limit);

  let checked = 0;
  let sent = 0;

  for (const row of due) {
    try {
      const result = await pollTarget(env, row.target_key, false);
      checked += result.checked || 0;
      sent += result.sent || 0;
    } catch {
      const retry = new Date(Date.now() + 15 * 60000);
      await env.DB.prepare(
        "UPDATE monitor_targets SET next_poll_at=? WHERE target_key=?"
      ).bind(isoNoZ(retry), row.target_key).run();
    }
  }

  return { checked, sent };
}

export default {
  async fetch(req, env, ctx) {
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
      const usage = env.DB ? await getUsage(env) : null;
      return json(env, {
        ok: true,
        service: "cineping-alert-api",
        version: "2026-09-26-district-monitor-v4",
        d1: !!env.DB,
        mailConfigured: !!(env.BREVO_API_KEY && env.BREVO_FROM_EMAIL),
        districtConfigured: !!env.PARSE_API_KEY,
        schedulerConfigured: !!env.PARSE_API_KEY,
        monthlyBudget: MONTHLY_CREDIT_CAP, monitorPolicy: { initialCheck: "immediate", priorityEveryMinutes: BURST_INTERVAL_MINUTES, preWindowEveryMinutes: NEAR_DATE_INTERVAL_MINUTES, normalEveryMinutes: NORMAL_INTERVAL_MINUTES, maxShowtimeCallsPerTarget: MAX_SHOWTIME_CALLS_PER_TARGET, monthlyCreditSafetyCap: MONTHLY_CREDIT_CAP },
        usage: usage ? {
          credits: Number(usage.credits_used || 0),
          catalogCalls: Number(usage.catalog_calls || 0),
          showtimeCalls: Number(usage.showtime_calls || 0)
        } : null
      });
    }

    if (u.pathname === "/api/alerts" && req.method === "POST") {
      try {
        const b = await req.json();
        const email = String(b.email || "").trim().toLowerCase();
        const movie = String(b.movie || "").trim();

        if (!email || !movie) return json(env, { error: "email and movie are required" }, 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(env, { error: "valid email required" }, 400);

        await ensureMonitorTables(env);

        const id = crypto.randomUUID();
        const token = crypto.randomUUID() + crypto.randomUUID();
        const city = String(b.city || "");
        const datePref = String(b.date || "Any date");
        const specificDate = String(b.specificDate || "");

        await env.DB.prepare(
          "INSERT INTO alerts(id,email,movie,city,theatres,language,format,time_pref,date_pref,specific_date,source,status,manage_token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))"
        ).bind(
          id,
          email,
          movie,
          city,
          JSON.stringify(Array.isArray(b.theatres) ? b.theatres : []),
          String(b.language || "Any"),
          String(b.format || "Any"),
          String(b.time || "Any time"),
          datePref,
          specificDate,
          JSON.stringify(Array.isArray(b.sources) && b.sources.length ? b.sources : ["Any"]),
          "active",
          token
        ).run();

        const alertRow = await env.DB.prepare("SELECT * FROM alerts WHERE id=?").bind(id).first();
        const targetKey = await upsertTarget(env, alertRow, true);

        let emailSent = false;
        try {
          await send(
            env,
            email,
            "CinePing alert armed · " + movie,
            "<p>Your CinePing alert for <strong>" + esc(movie) + "</strong> in <strong>" +
            esc(city || "India") + "</strong> is active.</p>" +
            "<p>Selected theatres: " + esc((b.theatres || []).join(", ") || "Any matching theatre") + ".</p>" +
            "<p>CinePing will check District for matching showtimes and email you when a matching booking appears.</p>"
          );
          emailSent = true;
        } catch {}

        let firstCheck = null;
        try {
          firstCheck = await pollTarget(env, targetKey, true);
        } catch (e) {
          firstCheck = { checked: 0, sent: 0, queued: true };
          await env.DB.prepare(
            "UPDATE monitor_targets SET next_poll_at=? WHERE target_key=?"
          ).bind(isoNoZ(new Date(Date.now() + 5 * 60000)), targetKey).run();
        }

        return json(env, { ok: true, id, emailSent, monitorStarted: true, firstCheck }, 201);
      } catch {
        return json(env, { error: "could not create alert" }, 500);
      }
    }

    if (u.pathname === "/api/monitor-status" && req.method === "GET") {
      try {
        const usage = await getUsage(env);
        const targets = await env.DB.prepare(
          "SELECT target_key,city,movie,date_pref,specific_date,movie_id,next_poll_at,burst_remaining,usage_month,showtime_calls_month,last_polled_at,last_match_at FROM monitor_targets WHERE active=1 ORDER BY next_poll_at"
        ).all();

        return json(env, {
          ok: true,
          districtConfigured: !!env.PARSE_API_KEY,
          monthlyBudget: MONTHLY_CREDIT_CAP,
          usage: usage ? {
            month: usage.month,
            credits: Number(usage.credits_used || 0),
            remaining: Math.max(0, MONTHLY_CREDIT_CAP - Number(usage.credits_used || 0)),
            catalogCalls: Number(usage.catalog_calls || 0),
            showtimeCalls: Number(usage.showtime_calls || 0)
          } : null,
          targets: targets.results || []
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
      try {
        const result = await processDueTargets(env, 2);
        await ensureMonitorTables(env);
        const current = await getMonitorState(env).catch(() => null);
        const next = await env.DB.prepare(
          "SELECT MIN(next_poll_at) AS next_poll_at FROM monitor_targets WHERE active=1"
        ).first();

        await setMonitorState(env, {
          last_run_at: isoNoZ(new Date()),
          last_success_at: isoNoZ(new Date()),
          next_run_at: next?.next_poll_at || null,
          checked: result.checked,
          sent: result.sent
        });
      } catch {}
    })());
  }
};
