'use strict';

require('dotenv').config();

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const bool = (v, def = false) => (v === undefined || v === '' ? def : TRUE.has(String(v).toLowerCase()));
const int = (v, def, min = -Infinity, max = Infinity) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

function loadConfig(env = process.env) {
  const errors = [];
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';
  const port = int(env.PORT, 3000, 1, 65535);
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');

  const need = (key) => {
    if (!env[key]) errors.push(`${key} is required (see .env.example)`);
    return env[key];
  };

  const mongoUri = need('MONGODB_URI');
  const sessionSecret = need('SESSION_SECRET');
  if (sessionSecret && sessionSecret.length < 32) errors.push('SESSION_SECRET must be at least 32 characters');

  const dataKeyRaw = need('DATA_ENCRYPTION_KEY');
  let dataKey = null;
  if (dataKeyRaw) {
    dataKey = Buffer.from(dataKeyRaw, 'base64');
    if (dataKey.length !== 32) errors.push('DATA_ENCRYPTION_KEY must be 32 random bytes, base64 encoded (run: npm run gen-secrets)');
  }

  const enableDevLogin = bool(env.ENABLE_DEV_LOGIN, false);
  const googleClientId = env.GOOGLE_CLIENT_ID || '';
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET || '';

  if (isProd) {
    if (!/^https:\/\//i.test(publicUrl)) errors.push('PUBLIC_URL must be an https:// URL in production');
    if (!googleClientId || !googleClientSecret) errors.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production');
    if (enableDevLogin) errors.push('ENABLE_DEV_LOGIN must not be enabled in production');
  }

  if (errors.length) {
    throw new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`);
  }

  const aiProvider = (env.AI_PROVIDER || 'anthropic').toLowerCase();
  if (!['anthropic', 'openai', 'gemini'].includes(aiProvider)) {
    throw new Error('Invalid configuration:\n - AI_PROVIDER must be anthropic, openai or gemini');
  }
  const defaultModels = { anthropic: 'claude-haiku-5-5', openai: 'gpt-4o-mini', gemini: 'gemini-2.0-flash' };

  return {
    nodeEnv,
    isProd,
    isTest,
    port,
    publicUrl,
    allowedOrigins: [publicUrl, ...list(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, ''))],
    trustProxy: env.TRUST_PROXY === undefined || env.TRUST_PROXY === '' ? false : (/^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : bool(env.TRUST_PROXY)),
    db: {
      uri: mongoUri,
      maxPoolSize: int(env.MONGO_MAX_POOL_SIZE, 20, 1, 500),
      minPoolSize: int(env.MONGO_MIN_POOL_SIZE, 2, 0, 100),
    },
    security: {
      sessionSecret,
      dataKey,
      cookieSecure: isProd ? true : 'auto',
      userSessionHours: int(env.USER_SESSION_HOURS, 168, 1, 24 * 90),
      adminIdleMinutes: int(env.ADMIN_IDLE_MINUTES, 30, 5, 24 * 60),
      adminAbsoluteHours: int(env.ADMIN_ABSOLUTE_HOURS, 8, 1, 72),
      adminRequireMfa: bool(env.ADMIN_REQUIRE_MFA, false),
      adminMaxFailedLogins: int(env.ADMIN_MAX_FAILED_LOGINS, 5, 3, 20),
      adminLockMinutes: int(env.ADMIN_LOCK_MINUTES, 15, 1, 24 * 60),
      rateLimitEnabled: !isTest || bool(env.TEST_ENABLE_RATE_LIMIT, false),
    },
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      redirectUri: `${publicUrl}/api/auth/google/callback`,
      enabled: Boolean(googleClientId && googleClientSecret),
    },
    enableDevLogin: !isProd && enableDevLogin,
    share: {
      requireVisit: bool(env.SHARE_REQUIRE_VISIT, true),
      dailyBonusLimit: int(env.SHARE_DAILY_BONUS_LIMIT, 3, 1, 100),
      minDelaySeconds: int(env.SHARE_MIN_DELAY_SECONDS, 15, 0, 3600),
      dayTimezone: env.SHARE_DAY_TIMEZONE || 'UTC',
    },
    chatbot: {
      enabled: bool(env.CHATBOT_ENABLED, true),
      provider: aiProvider,
      apiKey: env.AI_API_KEY || '',
      model: env.AI_MODEL || defaultModels[aiProvider],
      baseUrl: (env.AI_BASE_URL || '').replace(/\/+$/, ''),
      timeoutMs: int(env.AI_TIMEOUT_MS, 15000, 1000, 120000),
      maxInputChars: int(env.CHAT_MAX_INPUT_CHARS, 500, 50, 4000),
      ratePerMinute: int(env.CHAT_RATE_LIMIT_PER_MIN, 10, 1, 600),
      dailyLimitPerUser: int(env.CHAT_DAILY_LIMIT, 100, 1, 100000),
    },
  };
}

const config = loadConfig();

module.exports = { config, loadConfig };
