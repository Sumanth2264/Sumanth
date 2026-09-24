const CFG = {
  SHEET_NAME: 'Alerts',
  MAX_ALERTS_PER_EMAIL: 25,
  CREATE_COOLDOWN_MS: 10 * 60 * 1000,
  MATCH_COOLDOWN_MS: 24 * 60 * 60 * 1000
};

/**
 * CinePing free backend.
 * - Google Apps Script Web App (no Google Cloud billing required for this design)
 * - Stores alerts in a private spreadsheet owned by the deployer
 * - Uses Brevo transactional API for email delivery
 * - Does NOT request Gmail/Drive access beyond the spreadsheet this script creates
 * - Live showtime ingestion is intentionally separated: only an authorized feed
 *   should call ingestShows().
 */

function doGet(e) {
  return json_({ ok: true, service: 'CinePing Email Alert Backend', version: '1.0' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
    const action = String(body.action || '');

    if (honeypot_(body)) return json_({ ok: false, error: 'Rejected' });

    if (action === 'createAlert') return createAlert_(body);
    if (action === 'deleteAlert') return deleteAlert_(body);
    if (action === 'pauseAlert') return pauseAlert_(body);
    if (action === 'ingestShows') return ingestShows_(body);

    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: 'Request failed' });
  }
}

function createAlert_(body) {
  const email = normalizeEmail_(body.email);
  const movie = clean_(body.movie, 140);
  const city = clean_(body.city, 80);

  if (!isEmail_(email) || !movie || !city) {
    return json_({ ok: false, error: 'Valid email, movie and city are required.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const sheet = getSheet_();
    const values = sheet.getDataRange().getValues();
    const now = Date.now();

    let activeForEmail = 0;
    let lastCreatedForEmail = 0;

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (String(row[2]).toLowerCase() === email && String(row[12]).toUpperCase() === 'ARMED') {
        activeForEmail++;
      }
      if (String(row[2]).toLowerCase() === email) {
        const ts = new Date(row[0]).getTime();
        if (!isNaN(ts)) lastCreatedForEmail = Math.max(lastCreatedForEmail, ts);
      }
    }

    if (activeForEmail >= CFG.MAX_ALERTS_PER_EMAIL) {
      return json_({ ok: false, error: 'Maximum active alerts reached for this email.' });
    }
    if (lastCreatedForEmail && now - lastCreatedForEmail < CFG.CREATE_COOLDOWN_MS) {
      return json_({ ok: false, error: 'Please wait a few minutes before creating another alert.' });
    }

    const id = Utilities.getUuid();
    const manageToken = Utilities.getUuid().replace(/-/g, '');
    const row = [
      new Date(),
      id,
      email,
      movie,
      city,
      JSON.stringify(Array.isArray(body.theatres) ? body.theatres.slice(0, 30) : []),
      clean_(body.language, 40),
      clean_(body.format, 40),
      clean_(body.time, 60),
      clean_(body.date, 60),
      JSON.stringify(Array.isArray(body.sources) ? body.sources.slice(0, 5) : ['District', 'BookMyShow']),
      manageToken,
      'ARMED',
      '',
      ''
    ];
    sheet.appendRow(row);

    sendBrevo_(
      email,
      'Your CinePing alert is armed',
      '<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">' +
      '<h2>CinePing alert armed</h2>' +
      '<p>We are watching for <b>' + html_(movie) + '</b> in <b>' + html_(city) + '</b>.</p>' +
      '<p>When an authorised showtime feed produces a match, CinePing can email you with the official booking handoff.</p>' +
      '<p style="color:#666;font-size:12px">This email is a transactional alert from CinePing.</p>' +
      '</div>'
    );

    return json_({ ok: true, alertId: id, manageToken: manageToken, status: 'ARMED' });
  } finally {
    lock.releaseLock();
  }
}

function deleteAlert_(body) {
  const id = clean_(body.alertId, 100);
  const token = clean_(body.manageToken, 120);
  if (!id || !token) return json_({ ok: false, error: 'Missing alert credentials.' });

  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][1]) === id && String(values[i][11]) === token) {
      sheet.getRange(i + 1, 13).setValue('DELETED');
      return json_({ ok: true });
    }
  }
  return json_({ ok: false, error: 'Alert not found.' });
}

function pauseAlert_(body) {
  const id = clean_(body.alertId, 100);
  const token = clean_(body.manageToken, 120);
  const status = String(body.status || 'PAUSED').toUpperCase() === 'ARMED' ? 'ARMED' : 'PAUSED';
  if (!id || !token) return json_({ ok: false, error: 'Missing alert credentials.' });

  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][1]) === id && String(values[i][11]) === token) {
      sheet.getRange(i + 1, 13).setValue(status);
      return json_({ ok: true, status: status });
    }
  }
  return json_({ ok: false, error: 'Alert not found.' });
}

/**
 * Secure ingestion endpoint.
 * The caller must supply the INGEST_SECRET Script Property.
 * Body shape:
 * { action:"ingestShows", secret:"...", shows:[{
 *   movie, city, theatre, language, format, time, date, source, bookingUrl, tag
 * }] }
 *
 * Only use showtime data you are authorised to access.
 */
function ingestShows_(body) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('INGEST_SECRET');
  if (!expected || !body.secret || String(body.secret) !== expected) {
    return json_({ ok: false, error: 'Unauthorised' });
  }
  if (!Array.isArray(body.shows)) return json_({ ok: false, error: 'shows must be an array' });

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const sheet = getSheet_();
    const values = sheet.getDataRange().getValues();
    const now = Date.now();
    let sent = 0;

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const status = String(row[12]).toUpperCase();
      if (status !== 'ARMED') continue;

      const email = String(row[2]);
      const alert = {
        id: String(row[1]),
        email: email,
        movie: String(row[3]),
        city: String(row[4]),
        theatres: safeJson_(row[5], []),
        language: String(row[6]),
        format: String(row[7]),
        time: String(row[8]),
        date: String(row[9]),
        sources: safeJson_(row[10], []),
        lastSentKey: String(row[13] || '')
      };

      for (let s = 0; s < body.shows.length; s++) {
        const show = body.shows[s] || {};
        if (!matches_(alert, show)) continue;

        const matchKey = Utilities.base64EncodeWebSafe(
          [show.source, show.movie, show.city, show.theatre, show.date, show.time, show.bookingUrl].join('|')
        );

        const sentAt = row[14] ? new Date(row[14]).getTime() : 0;
        if (alert.lastSentKey === matchKey && sentAt && now - sentAt < CFG.MATCH_COOLDOWN_MS) {
          continue;
        }

        sendMatchEmail_(alert.email, alert.movie, show);
        sheet.getRange(r + 1, 14).setValue(matchKey);
        sheet.getRange(r + 1, 15).setValue(new Date());
        sent++;
        break;
      }
    }

    return json_({ ok: true, sent: sent });
  } finally {
    lock.releaseLock();
  }
}

function matches_(alert, show) {
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  if (!same(alert.movie, show.movie)) return false;
  if (!same(alert.city, show.city)) return false;

  if (alert.theatres.length) {
    const t = String(show.theatre || '').toLowerCase();
    if (!alert.theatres.some(x => String(x).toLowerCase() === t)) return false;
  }
  if (alert.language && alert.language !== 'Any' && !same(alert.language, show.language)) return false;
  if (alert.format && alert.format !== 'Any' && !same(alert.format, show.format)) return false;
  if (alert.sources.length && !alert.sources.some(x => same(x, show.source))) return false;

  if (alert.time === 'FDFS only' && String(show.tag || '').toUpperCase() !== 'FDFS') return false;
  return true;
}

function sendMatchEmail_(email, movie, show) {
  const url = clean_(show.bookingUrl, 1000);
  const booking = url
    ? '<p><a href="' + html_(url) + '" style="background:#ff4f7a;color:#fff;padding:12px 16px;text-decoration:none;border-radius:8px;display:inline-block">Open official booking</a></p>'
    : '';
  const html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">' +
    '<h2>🎬 CinePing match found</h2>' +
    '<p>Your watch for <b>' + html_(movie) + '</b> matched a show.</p>' +
    '<p><b>' + html_(show.theatre) + '</b><br>' +
    html_(show.city) + ' · ' + html_(show.date) + ' · ' + html_(show.time) + '<br>' +
    html_(show.language) + ' · ' + html_(show.format) + ' · ' + html_(show.source) + '</p>' +
    booking +
    '<p style="color:#666;font-size:12px">Booking is completed on the official provider website.</p>' +
    '</div>';

  sendBrevo_(email, 'CinePing match: ' + movie, html);
}

function sendBrevo_(to, subject, htmlContent) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('BREVO_API_KEY');
  const fromEmail = props.getProperty('BREVO_FROM_EMAIL');
  const fromName = props.getProperty('BREVO_FROM_NAME') || 'CinePing';

  if (!apiKey || !fromEmail) throw new Error('Email service not configured.');

  const payload = {
    sender: { name: fromName, email: fromEmail },
    to: [{ email: to }],
    subject: subject,
    htmlContent: htmlContent
  };

  const response = UrlFetchApp.fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) throw new Error('Brevo send failed: ' + status);
}

function getSheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('CINEPING_SHEET_ID');
  let ss;

  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('CinePing Private Alerts');
    props.setProperty('CINEPING_SHEET_ID', ss.getId());
  }

  let sheet = ss.getSheetByName(CFG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CFG.SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'createdAt','alertId','email','movie','city','theatres','language','format','time',
      'date','sources','manageToken','status','lastMatchKey','lastMatchAt'
    ]);
  }
  return sheet;
}

function normalizeEmail_(v) { return String(v || '').trim().toLowerCase(); }
function isEmail_(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function clean_(v, max) { return String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max); }
function safeJson_(v, fallback) { try { return JSON.parse(String(v || '')) || fallback; } catch (_) { return fallback; } }
function html_(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function honeypot_(body) { return String(body.website || '').trim() !== ''; }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
