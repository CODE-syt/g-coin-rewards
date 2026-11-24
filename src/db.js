'use strict';

const mongoose = require('mongoose');
const { config } = require('./config');
const models = require('./models');

mongoose.set('strictQuery', true);

async function connectDb(uri = config.db.uri) {
  await mongoose.connect(uri, {
    maxPoolSize: config.db.maxPoolSize,
    minPoolSize: config.db.minPoolSize,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  });
  // Build indexes (unique constraints are part of the correctness story) before serving traffic.
  await Promise.all(Object.values(models).map((m) => m.init()));
  return mongoose.connection;
}

const disconnectDb = () => mongoose.disconnect();

module.exports = { connectDb, disconnectDb, mongoose };
