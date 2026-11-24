'use strict';
// Loaded before any test file. Tests need a real MongoDB (set TEST_MONGODB_URI; the database name must contain "test").
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gcoin_test';
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghijklmnop';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.ENABLE_DEV_LOGIN = 'true';
process.env.PUBLIC_URL = 'http://localhost:3000';
for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'AI_API_KEY']) process.env[k] = '';
process.env.CHATBOT_ENABLED = 'true';
