const pool = require('./config');

if (process.env.I_REALLY_MEAN_IT !== 'YES') {
    console.error('REFUSING TO RUN: this script TRUNCATEs every table except parties / mirchi_types.');
    console.error('If this is truly what you want, re-run with:  I_REALLY_MEAN_IT=YES node src/db/wipeData.js');
    process.exit(1);
}

const clearAllDataGenerically = async () => {
    const client = await pool.connect();

    try {
        console.log('🔄 Starting full generic data wipe...');
        await client.query('BEGIN');

        // 1. Fetch all tables in the public schema
        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
        `);

        const tables = res.rows.map(r => r.table_name);
        // We only explicitly retain the names in these two master tables
        const tablesToRetain = ['parties', 'mirchi_types'];

        // 2. Truncate all other tables dynamically
        for (const tableName of tables) {
            if (!tablesToRetain.includes(tableName)) {
                console.log(`🧹 Wiping table: ${tableName}`);
                // Using CASCADE to clean anything connected to it automatically
                await client.query(`TRUNCATE TABLE "${tableName}" CASCADE`);
            }
        }

        // 3. Zero out ALL amounts in retained tables (as requested)
        console.log('🔄 Zeroing out ALL party balances (current_balance = 0, past_due = 0)...');
        await client.query(`
            UPDATE parties 
            SET current_balance = 0, past_due = 0
        `);

        console.log('🔄 Zeroing out mirchi rates...');
        await client.query(`
            UPDATE mirchi_types 
            SET current_rate = 0
        `);

        await client.query('COMMIT');

        console.log('✅ Generic data wipe completed successfully!');
        console.log('✅ EVERYTHING is completely zeroed and erased.');
        console.log('✅ Only Party and Mirchi Types are retained.');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Data wipe failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

clearAllDataGenerically().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
