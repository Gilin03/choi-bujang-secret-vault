export function createAuthProxyFetch({ supabaseUrl, appOrigin = globalThis.location?.origin,
  fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  const projectUrl = new URL(supabaseUrl);
  const authPrefix = `${projectUrl.pathname.replace(/\/$/u, '')}/auth/v1/`;
  if (!appOrigin || typeof fetchImpl !== 'function') throw new TypeError('Auth proxy fetch is unavailable');

  return async function authProxyFetch(input, init) {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const requestUrl = new URL(request.url);
    if (requestUrl.origin !== projectUrl.origin) return fetchImpl(request);
    if (!requestUrl.pathname.startsWith(authPrefix)) {
      throw new TypeError('Only Supabase Auth requests may use this client');
    }

    const endpoint = requestUrl.pathname.slice(authPrefix.length);
    if (!endpoint || endpoint.includes('..')) throw new TypeError('Invalid Supabase Auth route');
    const proxyUrl = new URL(`/api/auth-proxy/${endpoint}${requestUrl.search}`, appOrigin);
    const headers = new Headers(request.headers);
    headers.delete('apikey');
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    return fetchImpl(new Request(proxyUrl, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'manual',
      signal: request.signal,
    }));
  };
}
