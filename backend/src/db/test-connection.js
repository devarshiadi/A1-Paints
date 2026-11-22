const pool = require('./config');

async function testConnection() {
    try {
        const { rows } = await pool.query(`
            SELECT current_database() AS database,
                   current_user AS role,
                   inet_server_addr()::text AS server_address,
                   inet_server_port() AS server_port
        `);
        const { database, role, server_address, server_port } = rows[0];
        console.log(`PostgreSQL login succeeded: database=${database}, role=${role}, server=${server_address}:${server_port}`);
    } catch (err) {
        console.error(`PostgreSQL login failed: ${err.code || 'unknown'} ${err.message}`);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

testConnection();
