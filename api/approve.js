import { readConfig } from '../server/lib/config.js';
import { createAdminClient, createStore } from '../server/lib/store.js';
import { createApproveHandler } from '../server/lib/handlers.js';

export default function handler(req, res) {
  const config = readConfig();
  const store = config.supabaseUrl && config.serviceRoleKey ? createStore(createAdminClient(config)) : null;
  return createApproveHandler({ config, store })(req, res);
}
