const pool = require('./config');

const MIGRATION_KEY = 'migrate4_recompute_party_current_balance';

const migrate4 = async () => {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting database migration (migrate4)...');

        await client.query('BEGIN');

        await client.query(`
      CREATE TABLE IF NOT EXISTS migration_history (
        key VARCHAR(120) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        const already = await client.query('SELECT key FROM migration_history WHERE key = $1', [MIGRATION_KEY]);
        if (already.rows.length > 0) {
            await client.query('COMMIT');
            console.log('✅ migrate4 already applied. Skipping.');
            return;
        }

        await client.query(`
      UPDATE parties p
      SET current_balance = (
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
        - COALESCE((
          SELECT SUM(COALESCE(j.amount, 0))
          FROM party_jama_entries j
          WHERE j.party_id = p.id
        ), 0)
      ),
      updated_at = CURRENT_TIMESTAMP
    `);

        await client.query('INSERT INTO migration_history(key) VALUES ($1)', [MIGRATION_KEY]);

        await client.query('COMMIT');
        console.log('✅ migrate4 completed successfully!');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ migrate4 failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

migrate4().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
