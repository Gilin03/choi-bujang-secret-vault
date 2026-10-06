function json(payload, status) {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function createNotesHandler({ env = process.env, createClient } = {}) {
  return {
    async fetch(request) {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, 405);
      }

      const supabaseUrl = env.SUPABASE_URL;
      const secretKey = env.SUPABASE_SECRET_KEY;
      if (typeof supabaseUrl !== 'string' || !supabaseUrl
          || typeof secretKey !== 'string' || !secretKey) {
        return json({ error: 'Unable to load notes' }, 500);
      }

      try {
        const makeClient = createClient ?? (async (...args) => {
          const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');
          return createSupabaseClient(...args);
        });
        const supabase = await makeClient(supabaseUrl, secretKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
        });
        const { data, error } = await supabase
          .from('vault_notes')
          .select('title, content')
          .order('sort_order', { ascending: true });

        if (error || !Array.isArray(data)) {
          return json({ error: 'Unable to load notes' }, 500);
        }

        return json({
          notes: data.map(({ title, content }) => ({ title, content })),
        }, 200);
      } catch {
        return json({ error: 'Unable to load notes' }, 500);
      }
    },
  };
}

export default createNotesHandler();
