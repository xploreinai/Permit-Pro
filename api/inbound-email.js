import { readConfig } from '../server/lib/config.js';
import { createAdminClient, createStore } from '../server/lib/store.js';
import { createInboundHandler } from '../server/lib/handlers.js';

// The webhook signature is computed over the exact raw body, so Vercel's
// automatic body parsing must be off for this route.
export const config = { api: { bodyParser: false } };

export default function handler(req, res) {
  const appConfig = readConfig();
  const store = appConfig.supabaseUrl && appConfig.serviceRoleKey ? createStore(createAdminClient(appConfig)) : null;
  return createInboundHandler({ config: appConfig, store })(req, res);
}
