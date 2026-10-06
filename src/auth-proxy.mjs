const MAX_AUTH_BODY_BYTES = 16 * 1024;
const BEARER = /^Bearer\s+\S.{0,8190}$/iu;

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function validProjectUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash
        || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function routeFor(url, method) {
  const match = /^\/api\/auth-proxy\/(token|user|logout)$/u.exec(url.pathname);
  if (!match) return { error: json({ error: 'Not found' }, 404) };
  const endpoint = match[1];

  if (endpoint === 'token') {
    if (method !== 'POST') return { error: json({ error: 'Method not allowed' }, 405) };
    if (url.searchParams.size !== 1 || [...url.searchParams.keys()][0] !== 'grant_type'
        || !['password', 'refresh_token'].includes(url.searchParams.get('grant_type'))) {
      return { error: json({ error: 'Unsupported Auth grant' }, 400) };
    }
    return { endpoint, query: `?grant_type=${url.searchParams.get('grant_type')}` };
  }

  if (endpoint === 'user') {
    if (method !== 'GET') return { error: json({ error: 'Method not allowed' }, 405) };
    if (url.search) return { error: json({ error: 'Unsupported Auth query' }, 400) };
    return { endpoint, query: '' };
  }

  if (method !== 'POST') return { error: json({ error: 'Method not allowed' }, 405) };
  const scopes = url.searchParams.getAll('scope');
  if ([...url.searchParams.keys()].some(key => key !== 'scope') || scopes.length > 1
      || (scopes.length === 1 && !['global', 'local', 'others'].includes(scopes[0]))) {
    return { error: json({ error: 'Unsupported Auth query' }, 400) };
  }
  return { endpoint, query: scopes.length ? `?scope=${scopes[0]}` : '' };
}

export function createSupabaseAuthProxy({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function supabaseAuthProxy(request) {
    let incomingUrl;
    try {
      incomingUrl = new URL(request.url);
    } catch {
      return json({ error: 'Invalid request' }, 400);
    }

    const route = routeFor(incomingUrl, request.method);
    if (route.error) return route.error;

    const projectUrl = validProjectUrl(env.SUPABASE_URL);
    const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
    if (!projectUrl || typeof publishableKey !== 'string' || !publishableKey.trim()) {
      return json({ error: 'Auth service unavailable' }, 500);
    }

    let body;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const declaredLength = Number(request.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_AUTH_BODY_BYTES) {
        return json({ error: 'Auth request is too large' }, 413);
      }
      body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > MAX_AUTH_BODY_BYTES) return json({ error: 'Auth request is too large' }, 413);
      if (route.endpoint === 'logout' && body.byteLength > 0) {
        return json({ error: 'Unexpected Auth request body' }, 400);
      }
    }

    const headers = new Headers({
      apikey: publishableKey,
      accept: request.headers.get('accept') || 'application/json',
    });
    const clientInfo = request.headers.get('x-client-info');
    if (clientInfo && clientInfo.length <= 512) headers.set('x-client-info', clientInfo);

    if (route.endpoint === 'token') {
      headers.set('authorization', `Bearer ${publishableKey}`);
      headers.set('content-type', 'application/json');
    } else {
      const authorization = request.headers.get('authorization');
      if (!authorization || authorization.length > 8192 || !BEARER.test(authorization)) {
        return json({ error: 'Authentication required' }, 401);
      }
      headers.set('authorization', authorization);
    }

    const upstreamUrl = new URL(`/auth/v1/${route.endpoint}${route.query}`, projectUrl);
    try {
      const upstream = await fetchImpl(new Request(upstreamUrl, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        cache: 'no-store',
        redirect: 'manual',
        signal: request.signal,
      }));
      const responseBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304
        ? null
        : await upstream.arrayBuffer();
      return new Response(responseBody, {
        status: upstream.status,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return json({ error: 'Auth service unavailable' }, 502);
    }
  };
}

function requestHeaders(headers = {}) {
  const result = new Headers();
  for (const name of ['authorization', 'apikey', 'accept', 'content-type', 'x-client-info']) {
    const value = headers[name];
    if (typeof value === 'string') result.set(name, value);
  }
  return result;
}

function requestBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  if (typeof body === 'object') return JSON.stringify(body);
  return String(body);
}

export function createVercelAuthProxyAdapter(options = {}) {
  const proxy = createSupabaseAuthProxy(options);
  const endpoint = ['token', 'user', 'logout'].includes(options.endpoint) ? options.endpoint : null;
  return async function vercelAuthProxy(req, res) {
    try {
      const url = new URL(req.url || '/', 'https://vault.example');
      if (endpoint) {
        // Vercel may include a dynamic route parameter in req.url as a query
        // value. Keep the fixed endpoint from this handler and remove only its
        // synthetic parameter, while preserving legitimate Auth query values.
        if (req.query?.endpoint === endpoint && url.searchParams.get('endpoint') === endpoint) {
          url.searchParams.delete('endpoint');
        }
        url.pathname = `/api/auth-proxy/${endpoint}`;
      }
      const body = requestBody(req.body);
      const request = new Request(`https://vault.example${url.pathname}${url.search}`, {
        method: req.method || 'GET',
        headers: requestHeaders(req.headers),
        ...(body === undefined ? {} : { body }),
      });
      const response = await proxy(request);
      res.statusCode = response.status;
      for (const name of ['Cache-Control', 'Content-Type', 'X-Content-Type-Options']) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      const response = json({ error: 'Auth service unavailable' }, 500);
      res.statusCode = response.status;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  };
}
