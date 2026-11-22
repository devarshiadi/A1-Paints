/**
 * Self-check for the oversell guard. Everything runs inside a transaction that
 * is ALWAYS rolled back — no row survives this script.
 *   node src/db/test_stock.js
 */
const assert = require('assert');
const pool = require('./config');
const { deductStock, addStock } = require('./stock');

const remaining = async (client, id) =>
    Number((await client.query('SELECT remaining_quantity FROM lots WHERE id = $1', [id])).rows[0].remaining_quantity);

(async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
        const mirchi = (await client.query('SELECT id FROM mirchi_types LIMIT 1')).rows[0].id;
        const lotId = 'test-stock-guard';
        await client.query(
            `INSERT INTO lots (id, lot_number, mirchi_type_id, mirchi_name, total_quantity, remaining_quantity, purchase_date, status, avg_rate)
             VALUES ($1, $2, $3, 'TEST', 10, 10, CURRENT_DATE, 'active', 0)`,
            [lotId, 'TEST/GUARD', mirchi]
        );

        // normal sale
        await deductStock(client, 'lots', lotId, 4);
        assert.strictEqual(await remaining(client, lotId), 6, 'sale should leave 6');

        // oversell must be refused, and must not move the stock
        await assert.rejects(
            () => deductStock(client, 'lots', lotId, 7),
            /Not enough stock/,
            'selling 7 of 6 bags must be rejected'
        );
        assert.strictEqual(await remaining(client, lotId), 6, 'refused sale must not change stock');

        // selling exactly what is left is allowed and marks the lot sold out
        await deductStock(client, 'lots', lotId, 6);
        assert.strictEqual(await remaining(client, lotId), 0, 'lot should be empty');
        const status = (await client.query('SELECT status FROM lots WHERE id = $1', [lotId])).rows[0].status;
        assert.strictEqual(status, 'sold_out', 'emptied lot should be sold_out');

        // a sales return puts bags back and reopens the lot
        await addStock(client, 'lots', lotId, 2);
        assert.strictEqual(await remaining(client, lotId), 2, 'return should add bags back');

        // an empty lot cannot go negative either
        await assert.rejects(() => deductStock(client, 'lots', lotId, 3), /Not enough stock/);
        assert.strictEqual(await remaining(client, lotId), 2, 'stock never goes negative');

        console.log('✅ stock guard OK — oversell refused, stock never negative');
    } finally {
        await client.query('ROLLBACK');
        client.release();
        await pool.end();
    }
})();
