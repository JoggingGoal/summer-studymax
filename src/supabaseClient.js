import { createClient } from "@supabase/supabase-js";

// These come from a .env file you create yourself (see SETUP.md).
// Never commit real keys to a public repo — Vite only exposes vars
// prefixed with VITE_ to the browser, and the anon key is safe to
// expose publicly by design (Supabase enforces access via Row Level
// Security policies, set up in supabase-schema.sql).
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    "Missing Supabase env vars. Copy .env.example to .env and fill in your project URL + anon key."
  );
}

export const supabase = createClient(supabaseUrl || "", supabaseAnonKey || "");
