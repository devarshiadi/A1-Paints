/**
 * migrate10 — prevent duplicate expense rows per transaction.
 *
 * The expense / patti_expense tables are 1:1 with their parent tx in practice
 * but had no UNIQUE constraint. The list/detail SQL used to GROUP BY (t.id, e.id)
 * which masked any accidental duplicate by row-multiplying items × payments.
 * We've moved to lateral subqueries that always pick the latest expense row,
 * but a UNIQUE constraint stops the bad state arising in the first place.
 *
 * Idempotent — re-running is a no-op via migration_history guard.
 */

const pool = require('./config');

const KEY = 'migrate10_unique_expenses_per_tx';

async function dedupePerTx(client, table) {
    // Keep the row with the latest created_at (ties broken by id desc); delete the rest.
    const sql = `
        DELETE FROM ${table} a
         USING ${table} b
         WHERE a.transaction_id = b.transaction_id
           AND (a.created_at < b.created_at
                OR (a.created_at = b.created_at AND a.id < b.id))
    `;
    const r = await client.query(sql);
    return r.rowCount || 0;
}

async function addUnique(client, table, constraintName) {
    // Check existing constraint first — re-runs after a failure should not error.
    const { rows } = await client.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1`,
        [constraintName]
    );
    if (rows.length) return false;
    await client.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} UNIQUE (transaction_id)`
    );
    return true;
}

(async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `CREATE TABLE IF NOT EXISTS migration_history (
                key VARCHAR(120) PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`
        );

        const guard = await client.query('SELECT 1 FROM migration_history WHERE key = $1', [KEY]);
        if (guard.rows.length) {
            console.log(`[migrate10] already applied (${KEY}) — skipping`);
            await client.query('ROLLBACK');
            return;
        }

        const delExp = await dedupePerTx(client, 'expenses');
        const delPattiExp = await dedupePerTx(client, 'patti_expenses');
        console.log(`[migrate10] removed ${delExp} duplicate expenses rows`);
        console.log(`[migrate10] removed ${delPattiExp} duplicate patti_expenses rows`);

        const addedExp = await addUnique(client, 'expenses', 'expenses_tx_unique');
        const addedPattiExp = await addUnique(client, 'patti_expenses', 'patti_expenses_tx_unique');
        console.log(`[migrate10] expenses UNIQUE constraint: ${addedExp ? 'added' : 'already present'}`);
        console.log(`[migrate10] patti_expenses UNIQUE constraint: ${addedPattiExp ? 'added' : 'already present'}`);

        await client.query('INSERT INTO migration_history (key) VALUES ($1)', [KEY]);
        await client.query('COMMIT');
        console.log('[migrate10] done');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[migrate10] FAILED — rolled back:', e.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
})();
