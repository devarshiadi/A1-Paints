/**
 * Stock movement with an oversell guard.
 *
 * Every path that takes BAGS OUT of a lot (sale, purchase-return) routes
 * through deductStock, so the "is there actually stock left?" check lives in
 * one place instead of being repeated — or forgotten — at each call site.
 * Forgetting it is what drove 96 lots negative (-62 bags on lots,
 * -896.5 on patti_lots) before this guard existed.
 *
 * The check is part of the UPDATE (WHERE remaining_quantity >= $1), not a
 * separate SELECT, so two concurrent bills cannot both pass it.
 */

const TABLES = ['lots', 'patti_lots'];

const deductStock = async (client, table, lotId, quantity, { alsoTotal = false } = {}) => {
    if (!TABLES.includes(table)) throw new Error(`deductStock: unknown table ${table}`);
    if (!lotId || !quantity) return;

    const result = await client.query(
        `UPDATE ${table}
            SET remaining_quantity = remaining_quantity - $1,
                ${alsoTotal ? 'total_quantity = total_quantity - $1,' : ''}
                status = CASE WHEN remaining_quantity - $1 <= 0 THEN 'sold_out' ELSE 'active' END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND remaining_quantity >= $1
      RETURNING lot_number`,
        [quantity, lotId]
    );

    if (result.rowCount === 0) {
        const lot = await client.query(
            `SELECT lot_number, remaining_quantity, ${table === 'lots' ? 'unit' : "'units' AS unit"} FROM ${table} WHERE id = $1`,
            [lotId]
        );
        const err = new Error(
            lot.rows.length === 0
                ? `LOT not found (${lotId})`
                : `Not enough stock in LOT ${lot.rows[0].lot_number}: ` +
                  `${lot.rows[0].remaining_quantity} ${lot.rows[0].unit || 'units'} remaining, ${quantity} ${lot.rows[0].unit || 'units'} required`
        );
        err.statusCode = 400;
        throw err;
    }
};

// Bags coming back IN (sales return, purchase). No guard needed — stock only grows.
const addStock = async (client, table, lotId, quantity, { alsoTotal = false } = {}) => {
    if (!TABLES.includes(table)) throw new Error(`addStock: unknown table ${table}`);
    if (!lotId || !quantity) return;

    await client.query(
        `UPDATE ${table}
            SET remaining_quantity = remaining_quantity + $1,
                ${alsoTotal ? 'total_quantity = total_quantity + $1,' : ''}
                status = CASE WHEN remaining_quantity + $1 > 0 THEN 'active' ELSE status END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [quantity, lotId]
    );
};

module.exports = { deductStock, addStock };
