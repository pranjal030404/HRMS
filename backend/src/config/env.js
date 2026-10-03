const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const env = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'hrms_app',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hrms',
    connectionLimit: 12,
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTtlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '7', 10),
  },
  encryptionKey: (process.env.ENCRYPTION_KEY || 'arthvex-hrms-32byte-encryption-key!!').padEnd(32, '!').slice(0, 32),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  uploadDir: path.resolve(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads'),
  // Subscription/tenant lifecycle clock. 'off' for a read-only replica, a
  // one-off worker, or a migration run that must not move billing states.
  lifecycleSweeper: process.env.LIFECYCLE_SWEEPER || 'on',
};

// A production process that still holds the published development secrets would let
// anyone mint valid tokens and decrypt stored PAN / Aadhaar / bank data. Refuse to boot.
if (env.nodeEnv === 'production') {
  const weak = [];
  // The values in .env.example are published in the repository, so copying that file to a server
  // must not pass as "configured".
  const published = (v) => !v || /dev-|change-in-production|arthvex-hrms-32byte/i.test(v);
  if (published(process.env.JWT_ACCESS_SECRET) || env.jwt.accessSecret === 'dev-access-secret') weak.push('JWT_ACCESS_SECRET');
  if (published(process.env.JWT_REFRESH_SECRET) || env.jwt.refreshSecret === 'dev-refresh-secret') weak.push('JWT_REFRESH_SECRET');
  if (published(process.env.ENCRYPTION_KEY)) weak.push('ENCRYPTION_KEY');
  if (!process.env.DB_PASSWORD || process.env.DB_PASSWORD === 'HrmsApp@2026') weak.push('DB_PASSWORD');
  if (env.corsOrigin.includes('*')) weak.push('CORS_ORIGIN (wildcard)');
  if (weak.length) {
    throw new Error(`Refusing to start in production with default or missing secrets: ${weak.join(', ')}`);
  }
}

module.exports = env;
