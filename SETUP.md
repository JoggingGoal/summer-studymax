# Summer Study Pact — Setup Guide

This turns your study tracker into a real website with its own URL that
any of your friends can open on their phone's browser — no Claude needed,
no app store needed. Total setup time is about 15–20 minutes, and everything
used here is free.

You'll do three things, in this order:
1. Create a free Supabase project (this is your shared database)
2. Run one SQL script to set up the data table
3. Deploy the app to Vercel (this gives you the real URL)

---

## 1. Create your Supabase project (the shared backend)

1. Go to **https://supabase.com** and sign up (free, no credit card needed).
2. Click **New Project**. Pick any name (e.g. "study-pact"), generate a database
   password (save it somewhere, you won't need it again for this setup), and
   pick the region closest to you and your friends.
3. Wait ~2 minutes for the project to finish setting up.
4. Once it's ready, go to **Project Settings → API** (gear icon in the
   left sidebar, then "API").
5. You'll need two values from this page:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon public** key (a long string under "Project API keys")

   Keep this tab open — you'll paste these into a file in step 3.

## 2. Set up the database table

1. In Supabase, click **SQL Editor** in the left sidebar → **New query**.
2. Open the file `supabase-schema.sql` (included in this project), copy
   its entire contents, and paste it into the SQL editor.
3. Click **Run**. You should see "Success. No rows returned."

That's it — your database now has a `groups` table ready to go, with the
right permissions and realtime updates turned on.

## 3. Configure the app with your Supabase keys

1. In the project folder, find the file `.env.example`.
2. Make a copy of it named exactly `.env` (same folder, just remove `.example`).
3. Open `.env` and replace the two placeholder values with your real
   Project URL and anon public key from step 1:
   ```
   VITE_SUPABASE_URL=https://abcdefgh.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```
4. Save the file.

**Important:** never share your `.env` file publicly or commit it to a
public GitHub repo — though note the anon key is specifically designed
by Supabase to be exposed in frontend code (that's how every Supabase
app works), so this is more about good habit than a real secret leak.

## 4. Try it locally (optional, but good to confirm it works)

If you have Node.js installed on your computer:
```bash
npm install
npm run dev
```
This opens the app at `http://localhost:5173` — try creating a group and
confirm it works before deploying.

## 5. Deploy to Vercel (get your real URL)

The easiest path with no command line needed:

1. Go to **https://vercel.com** and sign up free (you can sign up with GitHub).
2. Push this project folder to a new GitHub repository:
   - Go to **https://github.com/new**, create a repo (can be private).
   - Follow GitHub's instructions to push this folder to it (or use
     GitHub Desktop if you prefer a UI instead of the command line).
3. Back in Vercel, click **Add New → Project**, and import that GitHub repo.
4. Before deploying, expand **Environment Variables** and add the same two
   values from your `.env` file:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Click **Deploy**. After a minute, Vercel gives you a live URL like
   `study-pact-yourname.vercel.app`.

That URL is the real thing — share it with your friends, anyone can open
it on any phone's browser, no install needed.

## 6. Add it to your home screen (feels like a real app)

Once everyone has the URL:
- **iPhone (Safari):** open the link → tap the Share icon → "Add to Home Screen"
- **Android (Chrome):** open the link → tap the ⋮ menu → "Install app" or
  "Add to Home Screen"

It'll get its own icon and open full-screen, just like a native app.

---

## How the group code system works

Same as before: whoever creates a group gets a 5-character code. Everyone
else opens the same URL and joins using that code. Now that this is a real
website with a real database, the code works across completely separate
devices and browsers — no shared Claude session required.

## Updating the app later

If you (or I) make further changes to the code, just push the updated files
to the same GitHub repo — Vercel automatically redeploys within a minute or
two, no manual steps needed.

## Costs

Both Supabase and Vercel's free tiers are generous and will comfortably
cover a friend group's summer study tracker — you won't hit limits unless
this somehow goes viral. No credit card is required for either free tier.
