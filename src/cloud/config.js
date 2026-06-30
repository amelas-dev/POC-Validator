// Lane — Supabase connection config.
//
// Both of these are SAFE to ship in client-side code. The anon key is designed to
// be public; Row-Level Security (see supabase/schema.sql) is what actually protects
// the data. NEVER put the service_role key here — that one bypasses RLS.

export const SUPABASE_URL = 'https://bjjqjlorehlgdiiaasba.supabase.co';

// The publishable / anon key from Project Settings → API. Safe to ship client-side.
// Newer projects issue "sb_publishable_..."; older ones a JWT starting "eyJ...".
// Both are fine here. NEVER use the "sb_secret_..." key — it bypasses RLS.
export const SUPABASE_ANON_KEY = 'sb_publishable_MvQHWk3Dfi57GMfnNSjcdA_uE6ug8c1';

// Whether cloud sync is wired up at all. When false, Lane runs fully on-device
// (localStorage + IndexedDB) exactly as before — the cloud layer no-ops.
export const CLOUD_ENABLED =
  SUPABASE_URL.startsWith('https://') &&
  (SUPABASE_ANON_KEY.startsWith('eyJ') ||
    SUPABASE_ANON_KEY.startsWith('sb_publishable_'));
