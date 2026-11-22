const pool = require('./config');

const MIGRATION_KEY = 'migrate6_bill_counters_and_patti_balance';

const migrate6 = async () => {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting database migration (migrate6)...');

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
            console.log('✅ migrate6 already applied. Skipping.');
            return;
        }

        // 1. Create bill_counters table for DB-based sequential bill numbers
        await client.query(`
      CREATE TABLE IF NOT EXISTS bill_counters (
        prefix VARCHAR(30) PRIMARY KEY,
        last_number INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        console.log('✅ Created table: bill_counters');

        // 2. Seed bill counters from existing transactions
        // Find the max numeric portion of existing bill numbers for each type
        const prefixes = [
            { prefix: 'JAWAAK', query: `SELECT COUNT(*) as cnt FROM transactions WHERE bill_type = 'jawaak' AND COALESCE(is_return, false) = false` },
            { prefix: 'AWAAK', query: `SELECT COUNT(*) as cnt FROM transactions WHERE bill_type = 'awaak' AND COALESCE(is_return, false) = false` },
            { prefix: 'JAWAAK-RET', query: `SELECT COUNT(*) as cnt FROM transactions WHERE bill_type = 'jawaak' AND COALESCE(is_return, false) = true` },
            { prefix: 'AWAAK-RET', query: `SELECT COUNT(*) as cnt FROM transactions WHERE bill_type = 'awaak' AND COALESCE(is_return, false) = true` },
            { prefix: 'PATTI-AWAAK', query: `SELECT COUNT(*) as cnt FROM patti_transactions WHERE bill_type = 'patti_awaak' AND COALESCE(is_return, false) = false` },
            { prefix: 'PATTI-JAWAAK', query: `SELECT COUNT(*) as cnt FROM patti_transactions WHERE bill_type = 'patti_jawaak' AND COALESCE(is_return, false) = false` },
            { prefix: 'PATTI-AWAAK-RET', query: `SELECT COUNT(*) as cnt FROM patti_transactions WHERE bill_type = 'patti_awaak' AND COALESCE(is_return, false) = true` },
            { prefix: 'PATTI-JAWAAK-RET', query: `SELECT COUNT(*) as cnt FROM patti_transactions WHERE bill_type = 'patti_jawaak' AND COALESCE(is_return, false) = true` },
        ];

        for (const { prefix, query } of prefixes) {
            const result = await client.query(query);
            const count = parseInt(result.rows[0].cnt) || 0;
            await client.query(
                `INSERT INTO bill_counters (prefix, last_number) VALUES ($1, $2)
                 ON CONFLICT (prefix) DO UPDATE SET last_number = GREATEST(bill_counters.last_number, $2)`,
                [prefix, count]
            );
            console.log(`  Counter ${prefix} seeded at: ${count}`);
        }
        console.log('✅ Seeded bill counters from existing data');

        // 3. Recompute party balances to include patti transaction dues
        // This is the critical fix: patti transactions were not updating party balances
        await client.query(`
      UPDATE parties p
      SET current_balance = (
        -- Regular transaction dues
        COALESCE((
          SELECT SUM(
            CASE
              WHEN t.bill_type = 'jawaak' AND COALESCE(t.is_return, false) = false THEN COALESCE(t.balance_amount, 0)
              WHEN t.bill_type = 'jawaak' AND COALESCE(t.is_return, false) = true  THEN -COALESCE(t.balance_amount, 0)
              WHEN t.bill_type = 'awaak'  AND COALESCE(t.is_return, false) = false THEN -COALESCE(t.balance_amount, 0)
              WHEN t.bill_type = 'awaak'  AND COALESCE(t.is_return, false) = true  THEN COALESCE(t.balance_amount, 0)
              ELSE 0
            END
          )
          FROM transactions t
          WHERE t.party_id = p.id
        ), 0)
        +
        -- Patti transaction dues (NEW: was missing before!)
        COALESCE((
          SELECT SUM(
            CASE
              WHEN pt.bill_type = 'patti_jawaak' AND COALESCE(pt.is_return, false) = false THEN COALESCE(pt.balance_amount, 0)
              WHEN pt.bill_type = 'patti_jawaak' AND COALESCE(pt.is_return, false) = true  THEN -COALESCE(pt.balance_amount, 0)
              WHEN pt.bill_type = 'patti_awaak'  AND COALESCE(pt.is_return, false) = false THEN -COALESCE(pt.balance_amount, 0)
              WHEN pt.bill_type = 'patti_awaak'  AND COALESCE(pt.is_return, false) = true  THEN COALESCE(pt.balance_amount, 0)
              ELSE 0
            END
          )
          FROM patti_transactions pt
          WHERE pt.party_id = p.id
        ), 0)
        -
        -- Jama entries (receipts)
        COALESCE((
          SELECT SUM(COALESCE(j.amount, 0))
          FROM party_jama_entries j
          WHERE j.party_id = p.id
        ), 0)
      ),
      updated_at = CURRENT_TIMESTAMP
    `);
        console.log('✅ Recomputed party balances (now including patti dues)');

        await client.query(
            'INSERT INTO migration_history(key) VALUES ($1)',
            [MIGRATION_KEY]
        );

        await client.query('COMMIT');
        console.log('✅ migrate6 completed successfully!');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ migrate6 failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

migrate6().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
