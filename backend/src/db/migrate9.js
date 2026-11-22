const pool = require('./config');

const MIGRATION_KEY = 'migrate9_add_gaadi_number_to_expenses';

/**
 * Add gaadi_number (vehicle registration number) to both expense tables.
 * Purely additive — no backfill, no math impact. Exists so Jawaak invoices
 * can record the vehicle number below "गाडी भरणी" in the summary.
 */
const migrate9 = async () => {
    const client = await pool.connect();
    try {
        console.log('Starting database migration (migrate9)...');
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS migration_history (
                key VARCHAR(120) PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const already = await client.query(
            'SELECT key FROM migration_history WHERE key = $1',
            [MIGRATION_KEY]
        );
        if (already.rows.length > 0) {
            await client.query('COMMIT');
            console.log('migrate9 already applied. Skipping.');
            return;
        }

        await client.query(`
            ALTER TABLE expenses
            ADD COLUMN IF NOT EXISTS gaadi_number VARCHAR(50)
        `);
        console.log('  Added gaadi_number to expenses');

        await client.query(`
            ALTER TABLE patti_expenses
            ADD COLUMN IF NOT EXISTS gaadi_number VARCHAR(50)
        `);
        console.log('  Added gaadi_number to patti_expenses');

        await client.query(
            'INSERT INTO migration_history(key) VALUES ($1)',
            [MIGRATION_KEY]
        );

        await client.query('COMMIT');
        console.log('migrate9 completed successfully!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('migrate9 failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

migrate9().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
