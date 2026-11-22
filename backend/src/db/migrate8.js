const pool = require('./config');

const MIGRATION_KEY = 'migrate8_single_global_bill_counter';

const migrate8 = async () => {
    const client = await pool.connect();

    try {
        console.log('Starting database migration (migrate8)...');

        await client.query('BEGIN');

        // Ensure migration_history table exists
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
            console.log('migrate8 already applied. Skipping.');
            return;
        }

        // Problem: Previously there were 8+ separate counters per bill type (J, A, P-J, P-A, etc.)
        // plus orphaned migration prefixes (JAWAAK, AWAAK, etc.).
        // Bills were NOT globally sequential — each type had its own sequence.
        //
        // Fix: Replace all separate counters with ONE global counter ('BILL').
        // Seed it with the MAX bill number found across ALL tables and ALL existing counters.

        // 1. Find max last_number from ALL existing bill_counters rows
        const counterMax = await client.query(
            'SELECT COALESCE(MAX(last_number), 0) as max_num FROM bill_counters'
        );
        const maxFromCounters = parseInt(counterMax.rows[0].max_num) || 0;
        console.log(`  Max from existing counters: ${maxFromCounters}`);

        // 2. Find max numeric bill number from transactions table
        // Filter out Date.now() timestamps (13+ digits) — those were from the old broken fallback
        const txMax = await client.query(`
            SELECT COALESCE(MAX(
                CASE
                    WHEN bill_number ~ '^[0-9]+$' AND LENGTH(bill_number) <= 6 THEN CAST(bill_number AS INTEGER)
                    WHEN bill_number ~ '-[0-9]+$' AND LENGTH(substring(bill_number from '-([0-9]+)$')) <= 6 THEN CAST(substring(bill_number from '-([0-9]+)$') AS INTEGER)
                    ELSE 0
                END
            ), 0) as max_num
            FROM transactions
        `);
        const maxFromTx = parseInt(txMax.rows[0].max_num) || 0;
        console.log(`  Max from transactions table: ${maxFromTx}`);

        // 3. Find max numeric bill number from patti_transactions table
        const pattiMax = await client.query(`
            SELECT COALESCE(MAX(
                CASE
                    WHEN bill_number ~ '^[0-9]+$' AND LENGTH(bill_number) <= 6 THEN CAST(bill_number AS INTEGER)
                    WHEN bill_number ~ '-[0-9]+$' AND LENGTH(substring(bill_number from '-([0-9]+)$')) <= 6 THEN CAST(substring(bill_number from '-([0-9]+)$') AS INTEGER)
                    ELSE 0
                END
            ), 0) as max_num
            FROM patti_transactions
        `);
        const maxFromPatti = parseInt(pattiMax.rows[0].max_num) || 0;
        console.log(`  Max from patti_transactions table: ${maxFromPatti}`);

        // 4. Take the overall maximum
        const globalMax = Math.max(maxFromCounters, maxFromTx, maxFromPatti);
        console.log(`  Global max bill number: ${globalMax}`);

        // 5. Delete ALL old counter rows (they're no longer needed)
        await client.query('DELETE FROM bill_counters');
        console.log('  Deleted all old counter rows');

        // 6. Insert the single global counter
        await client.query(
            `INSERT INTO bill_counters (prefix, last_number, updated_at) VALUES ('BILL', $1, CURRENT_TIMESTAMP)`,
            [globalMax]
        );
        console.log(`  Created global counter 'BILL' starting at: ${globalMax}`);
        console.log(`  Next bill number will be: ${globalMax + 1}`);

        // Record migration
        await client.query(
            'INSERT INTO migration_history(key) VALUES ($1)',
            [MIGRATION_KEY]
        );

        await client.query('COMMIT');
        console.log('migrate8 completed successfully!');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('migrate8 failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

migrate8().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
