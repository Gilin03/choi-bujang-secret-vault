import { createVercelAuthProxyAdapter } from '../../src/auth-proxy.mjs';

export default createVercelAuthProxyAdapter({ endpoint: 'logout' });
