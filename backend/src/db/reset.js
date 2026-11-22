const pool = require('./config');

const resetDatabase = async () => {
    const client = await pool.connect();

    try {
        console.log('🔄 Resetting database...');

        await client.query('BEGIN');

        // Drop all tables in reverse order of dependencies
        await client.query('DROP TABLE IF EXISTS payments CASCADE');
        await client.query('DROP TABLE IF EXISTS expenses CASCADE');
        await client.query('DROP TABLE IF EXISTS transaction_items CASCADE');
        await client.query('DROP TABLE IF EXISTS transactions CASCADE');
        await client.query('DROP TABLE IF EXISTS lots CASCADE');
        await client.query('DROP TABLE IF EXISTS mirchi_types CASCADE');
        await client.query('DROP TABLE IF EXISTS parties CASCADE');

        await client.query('COMMIT');
        console.log('✅ Database reset completed!');
        console.log('💡 Run "npm run migrate" to recreate tables');
        console.log('💡 Run "npm run seed" to populate with sample data');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Reset failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

resetDatabase().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
