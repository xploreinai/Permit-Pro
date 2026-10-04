// Server-only configuration. These variables are set in the Vercel dashboard
// (Project -> Settings -> Environment Variables) and must NEVER use the
// VITE_ prefix — VITE_ variables are bundled into the public browser code.

const list = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);

export function readConfig(env = process.env) {
  return {
    supabaseUrl: env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    resendApiKey: env.RESEND_API_KEY || '',
    emailFrom: env.EMAIL_FROM || '',
    appBaseUrl: (env.APP_BASE_URL || '').replace(/\/+$/, ''),
    approvers: {
      engineering: list(env.ENGINEERING_APPROVER_EMAILS),
      hcc: list(env.HCC_APPROVER_EMAILS),
    },
    // Domain that receives approval replies (e.g. abc123.resend.app). Optional:
    // without it the emails are link-only.
    inboundDomain: (env.INBOUND_REPLY_DOMAIN || '').trim(),
    webhookSecret: env.RESEND_WEBHOOK_SECRET || '',
    requestTtlHours: Number(env.APPROVAL_TTL_HOURS) || 168,
    resendCooldownMinutes: Number(env.APPROVAL_RESEND_COOLDOWN_MINUTES) || 5,
  };
}

// Names of required settings that are missing for the given feature.
export function missingSettings(config, feature) {
  const required = {
    send: ['supabaseUrl', 'serviceRoleKey', 'resendApiKey', 'emailFrom', 'appBaseUrl'],
    approve: ['supabaseUrl', 'serviceRoleKey'],
    inbound: ['supabaseUrl', 'serviceRoleKey', 'resendApiKey', 'emailFrom', 'webhookSecret'],
  }[feature];
  return required.filter((key) => !config[key]);
}
