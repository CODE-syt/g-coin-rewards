'use strict';

// Fail fast with a readable message (no stack trace) when configuration is invalid.
try { require('./config'); } catch (err) { console.error(err.message); process.exit(1); }

const { config } = require('./config');
const logger = require('./lib/logger');
const { connectDb, disconnectDb } = require('./db');
const { createApp } = require('./app');
const { runReconcile } = require('./services/reconcile');

async function main() {
  await connectDb();
  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info('server_started', { port: config.port, publicUrl: config.publicUrl, env: config.nodeEnv });
    if (!config.isProd) {
      console.log(`\n  G Coin Rewards is running\n  App:   ${config.publicUrl}\n  Admin: ${config.publicUrl}/admin/\n`);
      if (!config.google.enabled) console.log('  (Google sign-in is not configured; ' + (config.enableDevLogin ? 'dev login is enabled.)\n' : 'set GOOGLE_CLIENT_ID/SECRET or ENABLE_DEV_LOGIN=true.)\n'));
    }
  });

  // Repair anything a crash may have left half-done, now and every 5 minutes.
  const reconcile = () => runReconcile().catch((err) => logger.error('reconcile_failed', { message: err.message }));
  reconcile();
  const timer = setInterval(reconcile, 5 * 60_000);
  timer.unref();

  const shutdown = (signal) => {
    logger.info('shutdown', { signal });
    clearInterval(timer);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
