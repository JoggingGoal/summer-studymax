# Summer Study Pact

A study-accountability tracker for a friend group's summer. Log daily study
hours (4h weekdays / 3h weekends by default, fully editable), see everyone's
status on a shared calendar, vote on exemption requests and timelapse proof,
and track who's racking up the most "miss" points — because most points
when summer ends, loses.

**Start here → [SETUP.md](./SETUP.md)** for step-by-step deployment
instructions (free Supabase database + free Vercel hosting, ~15 minutes).

## What's in this project

- `src/App.jsx` — the entire app (UI, logic, styling)
- `src/supabaseClient.js` — connects the app to your Supabase database
- `supabase-schema.sql` — run this once in Supabase to set up the database
- `.env.example` — copy to `.env` and fill in your own Supabase keys
- `vite.config.js` — includes PWA config so the site is installable to
  a phone home screen

## Tech stack

- React + Vite
- Supabase (Postgres database + realtime sync, free tier)
- Deployed via Vercel (free tier)
- No login system — groups are joined via a shared 5-character code,
  the same trust model as a group chat invite link
