const pool = require('./config');

const migrate2 = async () => {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting database migration (migrate2)...');

        await client.query('BEGIN');

        // Add past_due (opening balance) to parties
        await client.query(`
      ALTER TABLE parties
      ADD COLUMN IF NOT EXISTS past_due DECIMAL(12, 2) DEFAULT 0
    `);

        // Ensure no NULL values exist
        await client.query(`
      UPDATE parties
      SET past_due = 0
      WHERE past_due IS NULL
    `);

        await client.query('COMMIT');
        console.log('✅ migrate2 completed successfully!');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ migrate2 failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

migrate2().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
