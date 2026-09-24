# CinePing Email Backend — Free Setup

This backend is designed for the website-only CinePing project. It uses Google Apps Script as a lightweight API and a private Google Sheet as the alert store. It does not require Google Cloud billing or Google OAuth for your visitors.

## 1. Create the Apps Script project

Go to https://script.google.com/ and create a new standalone project named "CinePing Backend".

Replace the default code with `Code.gs` from this folder.

## 2. Add Script Properties

In Apps Script:
Project Settings → Script properties → Add script property.

Add:

- `BREVO_API_KEY` = your Brevo API key
- `BREVO_FROM_EMAIL` = your verified Brevo sender email
- `BREVO_FROM_NAME` = CinePing
- `INGEST_SECRET` = a long random secret used only by your authorised showtime feed

Do NOT put these values into the public website or GitHub.

## 3. Deploy as a web app

Apps Script → Deploy → New deployment → Web app.

Execute as: Me.

Who has access: Anyone.

Copy the `/exec` URL.

Google documents that Apps Script web apps can be deployed with a public URL and configured to execute as the deploying user. See:
https://developers.google.com/apps-script/guides/web

## 4. Configure the website

The public GitHub Pages website needs the Apps Script /exec URL as its backend URL. This project keeps the website usable with a local fallback until you connect the backend.

## 5. Email limits

Brevo's current Free plan is 300 email sends per day, with no time limit; the free plan has no credit card requirement according to Brevo's current documentation.

Source:
https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan

This means CinePing can be free to users, but it cannot honestly be advertised as unlimited free email delivery.

## 6. Live showtime feed

The `ingestShows` endpoint is deliberately separated from the website. Only send showtimes from a provider/feed you are authorised to use.

Body shape:

{
  "action": "ingestShows",
  "secret": "YOUR_INGEST_SECRET",
  "shows": [
    {
      "movie": "Movie name",
      "city": "Hyderabad",
      "theatre": "Cinema name",
      "language": "Telugu",
      "format": "2D",
      "date": "2026-09-30",
      "time": "10:00 PM",
      "source": "District",
      "bookingUrl": "https://official-booking-url",
      "tag": "FDFS"
    }
  ]
}

The website should not claim live monitoring until an authorised feed is actually connected.
