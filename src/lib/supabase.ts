import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

/**
 * Server-side Supabase client, used for product image storage: issuing signed upload URLs
 * and removing objects when an image is deleted.
 *
 * This used to read process.env directly and fall back to empty strings. That looked
 * tolerant but wasn't -- createClient('', '') fails anyway, just later and with a message
 * that says nothing about which variable is missing. Reading from the validated env means
 * production cannot start misconfigured (env.ts requires these there), and a developer
 * missing them gets told exactly what to set rather than a Supabase internal error.
 */
const supabaseUrl = env.SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
    '(or SUPABASE_ANON_KEY). Product image upload and storage cleanup depend on them.'
  );
}

// The service-role key is deliberately server-only: it is what lets the backend sign an
// upload URL for a path the browser is not trusted to choose. It must never be exposed to
// the client (see frontend/src/services/image.service.ts).
export const supabase = createClient(supabaseUrl, supabaseKey);
