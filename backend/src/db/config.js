const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set before starting the backend.');
}

const databaseUrl = new URL(process.env.DATABASE_URL);
// pg's URL parser turns sslmode=require into certificate verification enabled.
// Aiven requires TLS here, while this app explicitly uses the provider's
// managed certificate chain policy below.
databaseUrl.searchParams.delete('sslmode');

const pool = new Pool({
    connectionString: databaseUrl.toString(),
    ssl: { rejectUnauthorized: false },
    max: parseInt(process.env.DB_POOL_MAX || '5', 10),
    min: parseInt(process.env.DB_POOL_MIN || '1', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
});

pool.on('connect', () => {
    console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client', err.message);
});

module.exports = pool;
