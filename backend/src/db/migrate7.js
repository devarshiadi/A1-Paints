const pool = require('./config');

const MIGRATION_KEY = 'migrate7_fix_bill_counter_seeding';

const migrate7 = async () => {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting database migration (migrate7)...');

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
            console.log('✅ migrate7 already applied. Skipping.');
            return;
        }

        // 1. Correctly seed bill counters from existing transactions using MAX numeric value
        const prefixes = [
            { prefix: 'JAWAAK', table: 'transactions', type: 'jawaak', is_return: false },
            { prefix: 'AWAAK', table: 'transactions', type: 'awaak', is_return: false },
            { prefix: 'JAWAAK-RET', table: 'transactions', type: 'jawaak', is_return: true },
            { prefix: 'AWAAK-RET', table: 'transactions', type: 'awaak', is_return: true },
            { prefix: 'PATTI-AWAAK', table: 'patti_transactions', type: 'patti_awaak', is_return: false },
            { prefix: 'PATTI-JAWAAK', table: 'patti_transactions', type: 'patti_jawaak', is_return: false },
            { prefix: 'PATTI-AWAAK-RET', table: 'patti_transactions', type: 'patti_awaak', is_return: true },
            { prefix: 'PATTI-JAWAAK-RET', table: 'patti_transactions', type: 'patti_jawaak', is_return: true },
        ];

        for (const { prefix, table, type, is_return } of prefixes) {
            // Try to extract the numeric part from bill_number string
            // Some might be pure numbers, some might have prefixes (if user manually fixed some)
            const query = `
                SELECT COALESCE(MAX(
                    CASE 
                        WHEN bill_number ~ '^[0-9]+$' THEN CAST(bill_number AS INTEGER)
                        WHEN bill_number ~ '-[0-9]+$' THEN CAST(substring(bill_number from '-([0-9]+)$') AS INTEGER)
                        ELSE 0
                    END
                ), 0) as max_num
                FROM ${table}
                WHERE bill_type = $1 AND COALESCE(is_return, false) = $2
            `;
            const result = await client.query(query, [type, is_return]);
            const maxNum = parseInt(result.rows[0].max_num) || 0;

            await client.query(
                `INSERT INTO bill_counters (prefix, last_number) VALUES ($1, $2)
                 ON CONFLICT (prefix) DO UPDATE SET last_number = GREATEST(bill_counters.last_number, $2)`,
                [prefix, maxNum]
            );
            console.log(`  Counter ${prefix} updated to: ${maxNum}`);
        }

        await client.query(
            'INSERT INTO migration_history(key) VALUES ($1)',
            [MIGRATION_KEY]
        );

        await client.query('COMMIT');
        console.log('✅ migrate7 completed successfully!');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ migrate7 failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

migrate7().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
