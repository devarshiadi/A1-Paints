const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const { v4: uuidv4 } = require('uuid');
const { BALANCE_BEFORE_BILL_SQL } = require('./pdf');
const { deductStock, addStock } = require('../db/stock');

const fetchPattiTransaction = async (client, transactionId) => {
    // Lateral subqueries — no GROUP BY, no row multiplication when a tx
    // has multiple items AND multiple payments.
    const result = await client.query(`
      SELECT t.*,
             pa.phone           AS party_phone,
             pa.past_due        AS party_past_due,
             pa.current_balance AS party_current_balance,
             (${BALANCE_BEFORE_BILL_SQL}) AS party_balance_before_bill,
             COALESCE((
                 SELECT json_agg(jsonb_build_object(
                     'id', ti.id,
                     'mirchi_type_id', ti.mirchi_type_id,
                     'mirchi_name', ti.mirchi_name,
                     'quality', ti.quality,
                     'lot_id', ti.lot_id,
                     'lot_number', ti.lot_number,
                     'poti_weights', ti.poti_weights,
                     'gross_weight', ti.gross_weight,
                     'poti_count', ti.poti_count,
                     'total_potya', ti.total_potya,
                     'net_weight', ti.net_weight,
                     'rate_per_kg', ti.rate_per_kg,
                     'item_total', ti.item_total
                 ))
                 FROM patti_transaction_items ti
                 WHERE ti.transaction_id = t.id
             ), '[]'::json) AS items,
             COALESCE((
                 SELECT json_build_object(
                     'packing', e.packing,
                     'godown', e.godown,
                     'hamali', e.hamali,
                     'commission', e.commission,
                     'gaadi_bhade', e.gaadi_bhade,
                     'gaadi_number', e.gaadi_number,
                     'advance', e.advance,
                     'other_expenses', e.other_expenses
                 )
                 FROM patti_expenses e
                 WHERE e.transaction_id = t.id
                 ORDER BY e.created_at DESC NULLS LAST, e.id DESC
                 LIMIT 1
             ), '{}'::json) AS expenses,
             COALESCE((
                 SELECT json_agg(jsonb_build_object(
                     'mode', p.mode,
                     'amount', p.amount,
                     'reference', p.reference
                 ))
                 FROM patti_payments p
                 WHERE p.transaction_id = t.id
             ), '[]'::json) AS payments
      FROM patti_transactions t
      LEFT JOIN parties pa ON pa.id = t.party_id
      WHERE t.id = $1
    `, [transactionId]);

    return result.rows[0];
};

// GET patti transactions (paginated, see /transactions in transactions.js for header contract).
router.get('/transactions', async (req, res) => {
    try {
        const { party_id, bill_type, is_return, invoice_group_id } = req.query;

        const rawLimit = parseInt(req.query.limit ?? req.query.pageSize, 10);
        const rawPage = parseInt(req.query.page, 10);
        const rawOffset = parseInt(req.query.offset, 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
        const offset = Number.isFinite(rawOffset) && rawOffset >= 0
            ? rawOffset
            : (Number.isFinite(rawPage) && rawPage > 0 ? (rawPage - 1) * limit : 0);

        let query = `
      SELECT t.*,
             pa.phone           AS party_phone,
             pa.past_due        AS party_past_due,
             pa.current_balance AS party_current_balance,
             (${BALANCE_BEFORE_BILL_SQL}) AS party_balance_before_bill,
             COALESCE((
                 SELECT json_agg(jsonb_build_object(
                     'id', ti.id,
                     'mirchi_type_id', ti.mirchi_type_id,
                     'mirchi_name', ti.mirchi_name,
                     'quality', ti.quality,
                     'lot_id', ti.lot_id,
                     'lot_number', ti.lot_number,
                     'poti_weights', ti.poti_weights,
                     'gross_weight', ti.gross_weight,
                     'poti_count', ti.poti_count,
                     'total_potya', ti.total_potya,
                     'net_weight', ti.net_weight,
                     'rate_per_kg', ti.rate_per_kg,
                     'item_total', ti.item_total
                 ))
                 FROM patti_transaction_items ti
                 WHERE ti.transaction_id = t.id
             ), '[]'::json) AS items,
             COALESCE((
                 SELECT json_build_object(
                     'packing', e.packing,
                     'godown', e.godown,
                     'hamali', e.hamali,
                     'commission', e.commission,
                     'gaadi_bhade', e.gaadi_bhade,
                     'gaadi_number', e.gaadi_number,
                     'advance', e.advance,
                     'other_expenses', e.other_expenses
                 )
                 FROM patti_expenses e
                 WHERE e.transaction_id = t.id
                 ORDER BY e.created_at DESC NULLS LAST, e.id DESC
                 LIMIT 1
             ), '{}'::json) AS expenses,
             COALESCE((
                 SELECT json_agg(jsonb_build_object(
                     'mode', p.mode,
                     'amount', p.amount,
                     'reference', p.reference
                 ))
                 FROM patti_payments p
                 WHERE p.transaction_id = t.id
             ), '[]'::json) AS payments
      FROM patti_transactions t
      LEFT JOIN parties pa ON pa.id = t.party_id
    `;

        const conditions = [];
        const params = [];
        let paramCount = 1;

        if (party_id) {
            conditions.push(`t.party_id = $${paramCount}`);
            params.push(party_id);
            paramCount++;
        }

        if (bill_type) {
            conditions.push(`t.bill_type = $${paramCount}`);
            params.push(bill_type);
            paramCount++;
        }

        if (is_return !== undefined) {
            conditions.push(`t.is_return = $${paramCount}`);
            params.push(is_return === 'true');
            paramCount++;
        }

        if (invoice_group_id) {
            conditions.push(`t.invoice_group_id = $${paramCount}`);
            params.push(invoice_group_id);
            paramCount++;
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        let countQuery = 'SELECT COUNT(*)::int AS total FROM patti_transactions t';
        if (conditions.length > 0) {
            countQuery += ' WHERE ' + conditions.join(' AND ');
        }

        query += ` ORDER BY t.bill_date DESC, t.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        const dataParams = [...params, limit, offset];

        const [dataRes, countRes] = await Promise.all([
            pool.query(query, dataParams),
            pool.query(countQuery, params),
        ]);
        const total = countRes.rows[0]?.total ?? 0;
        res.set('X-Total-Count', String(total));
        res.set('X-Page-Limit', String(limit));
        res.set('X-Page-Offset', String(offset));
        res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Page-Limit, X-Page-Offset');
        res.json(dataRes.rows);
    } catch (error) {
        console.error('Error fetching patti transactions:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET all patti lots (including depleted ones)
router.get('/lots/all', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM patti_lots 
       ORDER BY purchase_date DESC`
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching all patti lots:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET patti active lots
router.get('/lots/active', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM patti_lots 
       WHERE status = 'active' 
       ORDER BY purchase_date DESC`
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching patti lots:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET patti available lots by mirchi type (all lots for dropdown)
router.get('/lots/available/:mirchiTypeId', async (req, res) => {
    try {
        const { mirchiTypeId } = req.params;
        const result = await pool.query(
            `SELECT pl.*, 
                    COALESCE(
                        SUM(
                            CASE 
                                WHEN pt.bill_type = 'patti_awaak' THEN 
                                    CASE WHEN pt.is_return THEN -pti.poti_count ELSE pti.poti_count END
                                WHEN pt.bill_type = 'patti_jawaak' THEN 
                                    CASE WHEN pt.is_return THEN pti.poti_count ELSE -pti.poti_count END
                                ELSE 0
                            END
                        ), 0
                    ) as poti_count
             FROM patti_lots pl
             LEFT JOIN patti_transaction_items pti ON pl.id = pti.lot_id
             LEFT JOIN patti_transactions pt ON pti.transaction_id = pt.id
             WHERE pl.mirchi_type_id = $1
               AND pl.status = 'active'
             GROUP BY pl.id
             ORDER BY pl.purchase_date DESC`,
            [mirchiTypeId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching patti available lots:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Remove a patti lot from sellable stock (soft delete, same as DELETE /lots/:id).
// A fresh Patti Awaak on the same lot_number re-activates it.
router.delete('/lots/:id', async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE patti_lots
             SET status = 'sold_out', remaining_quantity = 0, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING id`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Patti lot not found' });
        }
        res.json({ success: true, message: 'Patti lot removed from stock' });
    } catch (error) {
        console.error('Error removing patti lot:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

const insertPattiTransaction = async (client, payload, billType) => {
    const {
        id,
        bill_number,
        bill_date,
        is_return,
        party_id,
        party_name,
        invoice_group_id,
        items,
        expenses,
        payments,
        gross_weight_total,
        net_weight_total,
        subtotal,
        total_expenses,
        total_amount,
        paid_amount,
        balance_amount,
    } = payload;

    if (!party_id) {
        return { error: 'Party is required' };
    }

    if (!items || items.length === 0) {
        return { error: 'At least one item is required' };
    }

    const transactionId = id || uuidv4();

    await client.query(
        `INSERT INTO patti_transactions (
        id, bill_number, bill_date, bill_type, is_return, party_id, party_name, invoice_group_id,
        gross_weight_total, net_weight_total, subtotal, total_expenses,
        total_amount, paid_amount, balance_amount
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *`,
        [
            transactionId,
            bill_number,
            bill_date,
            billType,
            is_return || false,
            party_id,
            party_name,
            invoice_group_id || null,
            gross_weight_total,
            net_weight_total,
            subtotal,
            total_expenses,
            total_amount,
            paid_amount,
            balance_amount,
        ]
    );

    for (const item of items) {
        const itemId = item.id || uuidv4();
        await client.query(
            `INSERT INTO patti_transaction_items (
          id, transaction_id, mirchi_type_id, mirchi_name, quality, lot_id,
          lot_number, poti_weights, gross_weight, poti_count, total_potya, net_weight,
          rate_per_kg, item_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
                itemId,
                transactionId,
                item.mirchi_type_id,
                item.mirchi_name,
                item.quality || null,
                item.lot_id || null,
                item.lot_number || null,
                JSON.stringify(item.poti_weights || []),
                item.gross_weight,
                item.poti_count,
                item.total_potya || 0,
                item.net_weight,
                item.rate_per_kg,
                item.item_total,
            ]
        );
    }

    if (expenses) {
        await client.query(
            `INSERT INTO patti_expenses (
          transaction_id, packing, godown, hamali, commission, gaadi_bhade, gaadi_number, advance, other_expenses
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
                transactionId,
                expenses.packing || 0,
                expenses.godown || 0,
                expenses.hamali || 0,
                expenses.commission || 0,
                expenses.gaadi_bhade || 0,
                expenses.gaadi_number || null,
                expenses.advance || 0,
                expenses.other_expenses || 0,
            ]
        );
    }

    if (payments && payments.length > 0) {
        for (const payment of payments) {
            if (payment.amount > 0) {
                await client.query(
                    `INSERT INTO patti_payments (transaction_id, mode, amount, reference)
           VALUES ($1, $2, $3, $4)`,
                    [transactionId, payment.mode, payment.amount, payment.reference]
                );
            }
        }
    }

    return { transactionId };
};

// STOCK UNIT for patti_lots = BAGS (poti_count). Patti owners record bag count only —
// gross_weight stays 0 on patti_awaak by design and is locked in when bags are sold via patti_jawaak.
const upsertPattiLotForAwaak = async (client, item, billDate) => {
    const mirchi = await client.query('SELECT name FROM mirchi_types WHERE id = $1', [item.mirchi_type_id]);
    const mirchiName = mirchi.rows[0]?.name || 'Unknown';
    const lotNumber = item.lot_number;
    const bags = parseInt(item.poti_count, 10) || 0;

    if (!lotNumber) {
        throw new Error('LOT number is required for Patti Awaak');
    }

    const existingLot = await client.query(
        'SELECT id FROM patti_lots WHERE lot_number = $1',
        [lotNumber]
    );

    if (existingLot.rows.length > 0) {
        const lotId = existingLot.rows[0].id;
        await client.query(
            `UPDATE patti_lots
             SET total_quantity = total_quantity + $1,
                 remaining_quantity = remaining_quantity + $1,
                 status = 'active',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [bags, lotId]
        );

        return lotId;
    }

    const lotId = uuidv4();
    await client.query(
        `INSERT INTO patti_lots (id, lot_number, mirchi_type_id, mirchi_name, total_quantity, remaining_quantity, purchase_date, status, avg_rate, owner_party_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            lotId,
            lotNumber,
            item.mirchi_type_id,
            mirchiName,
            bags,
            bags,
            billDate,
            'active',
            item.rate_per_kg,
            item.owner_party_id || null
        ]
    );

    return lotId;
};

const applyPattiAwaakStock = async (client, items, isReturn) => {
    if (!items || items.length === 0) return;

    for (const item of items) {
        if (!item.lot_id) continue;
        const bags = parseInt(item.poti_count, 10) || 0;

        if (isReturn) {
            // Patti awaak return: bags leave the lot (returning to patti owner)
            await deductStock(client, 'patti_lots', item.lot_id, bags, { alsoTotal: true });
        }
    }
};

const applyPattiJawaakStock = async (client, items, isReturn) => {
    if (!items || items.length === 0) return;

    for (const item of items) {
        if (!item.lot_id) continue;
        const bags = parseInt(item.poti_count, 10) || 0;

        if (isReturn) {
            await addStock(client, 'patti_lots', item.lot_id, bags);
        } else {
            await deductStock(client, 'patti_lots', item.lot_id, bags);
        }
    }
};

// POST create patti awaak
router.post('/awaak', async (req, res) => {
    const client = await pool.connect();

    try {
        const payload = req.body;
        const normalizedItems = [...(payload.items || [])];

        // BEGIN first so lot upsert is inside the transaction — rollback undoes everything
        await client.query('BEGIN');

        if (!payload.is_return) {
            for (const item of normalizedItems) {
                const lotId = await upsertPattiLotForAwaak(client, item, payload.bill_date);
                item.lot_id = lotId;
            }
        }

        const insertResult = await insertPattiTransaction(
            client,
            { ...payload, items: normalizedItems },
            'patti_awaak'
        );
        if (insertResult.error) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: insertResult.error });
        }

        // Patti Awaak return reduces stock (net). Incoming handled in upsert above.
        await applyPattiAwaakStock(client, normalizedItems, payload.is_return);

        // Update party balance: AWAAK = purchase → increases payable (negative balance)
        const balanceAmount = parseFloat(payload.balance_amount) || 0;
        if (balanceAmount > 0) {
            const sign = -1; // awaak = we owe them
            const dir = payload.is_return ? -1 : 1;
            const balanceDelta = sign * dir * balanceAmount;
            await client.query(
                'UPDATE parties SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [balanceDelta, payload.party_id]
            );
        }

        await client.query('COMMIT');

        const completeTransaction = await fetchPattiTransaction(client, insertResult.transactionId);
        res.json({ success: true, data: completeTransaction, message: 'Patti Awaak saved successfully' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error saving patti awaak:', error);
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// POST create patti jawaak
router.post('/jawaak', async (req, res) => {
    const client = await pool.connect();

    try {
        const payload = req.body;

        await client.query('BEGIN');

        const insertResult = await insertPattiTransaction(client, payload, 'patti_jawaak');
        if (insertResult.error) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: insertResult.error });
        }

        // Patti Jawaak reduces stock (gross) or adds back on return
        await applyPattiJawaakStock(client, payload.items, payload.is_return);

        // Update party balance: JAWAAK = sale → increases receivable (positive balance)
        const balanceAmount = parseFloat(payload.balance_amount) || 0;
        if (balanceAmount > 0) {
            const sign = 1; // jawaak = they owe us
            const dir = payload.is_return ? -1 : 1;
            const balanceDelta = sign * dir * balanceAmount;
            await client.query(
                'UPDATE parties SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [balanceDelta, payload.party_id]
            );
        }

        await client.query('COMMIT');

        const completeTransaction = await fetchPattiTransaction(client, insertResult.transactionId);
        res.json({ success: true, data: completeTransaction, message: 'Patti Jawaak saved successfully' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error saving patti jawaak:', error);
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// PATCH update patti transaction payment (pay off due)
router.patch('/transactions/:id/payment', async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
        }

        await client.query('BEGIN');

        const txResult = await client.query(
            'SELECT * FROM patti_transactions WHERE id = $1',
            [id]
        );

        if (txResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Patti transaction not found' });
        }

        const tx = txResult.rows[0];

        if (amount > parseFloat(tx.balance_amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: `Amount (${amount}) exceeds due balance (${tx.balance_amount})` });
        }

        // Update patti transaction
        await client.query(
            `UPDATE patti_transactions 
       SET paid_amount = paid_amount + $1, 
           balance_amount = balance_amount - $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
            [amount, id]
        );

        // Add payment record
        await client.query(
            `INSERT INTO patti_payments (transaction_id, mode, amount, reference)
       VALUES ($1, $2, $3, $4)`,
            [id, 'cash', amount, `Due Payment - ${new Date().toLocaleDateString()}`]
        );

        // Update party balance: paying off reduces receivable/payable
        if (tx.bill_type === 'patti_jawaak') {
            // Sales: reduce receivable
            await client.query(
                'UPDATE parties SET current_balance = current_balance - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [amount, tx.party_id]
            );
        } else {
            // Purchase: reduce payable
            await client.query(
                'UPDATE parties SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [amount, tx.party_id]
            );
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Patti payment updated successfully'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating patti payment:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// POST revert patti transaction
router.post('/transactions/:id/revert', async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;

        await client.query('BEGIN');

        const txResult = await client.query(
            'SELECT * FROM patti_transactions WHERE id = $1',
            [id]
        );

        if (txResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Patti transaction not found' });
        }

        const tx = txResult.rows[0];

        const itemsResult = await client.query(
            'SELECT * FROM patti_transaction_items WHERE transaction_id = $1',
            [id]
        );

        const items = itemsResult.rows;

        // Rollback lots — STOCK UNIT = BAGS (poti_count)
        for (const item of items) {
            if (!item.lot_id) continue;

            const bags = parseInt(item.poti_count, 10) || 0;

            if (tx.bill_type === 'patti_awaak' && !tx.is_return) {
                // Reverting patti awaak: subtract bags that were added
                await client.query(
                    `UPDATE patti_lots
                     SET total_quantity = total_quantity - $1,
                         remaining_quantity = remaining_quantity - $1,
                         status = CASE WHEN remaining_quantity - $1 <= 0 THEN 'sold_out' ELSE 'active' END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [bags, item.lot_id]
                );
            } else if (tx.bill_type === 'patti_awaak' && tx.is_return) {
                // Reverting patti awaak return: add bags back
                await client.query(
                    `UPDATE patti_lots
                     SET total_quantity = total_quantity + $1,
                         remaining_quantity = remaining_quantity + $1,
                         status = 'active',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [bags, item.lot_id]
                );
            } else if (tx.bill_type === 'patti_jawaak' && !tx.is_return) {
                // Reverting patti jawaak: add bags back
                await client.query(
                    `UPDATE patti_lots
                     SET remaining_quantity = remaining_quantity + $1,
                         status = CASE WHEN remaining_quantity + $1 > 0 THEN 'active' ELSE status END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [bags, item.lot_id]
                );
            } else if (tx.bill_type === 'patti_jawaak' && tx.is_return) {
                // Reverting patti jawaak return: subtract bags
                await client.query(
                    `UPDATE patti_lots
                     SET remaining_quantity = remaining_quantity - $1,
                         status = CASE WHEN remaining_quantity - $1 <= 0 THEN 'sold_out' ELSE 'active' END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [bags, item.lot_id]
                );
            }
        }

        // Rollback party balance
        const balanceAmount = Number(tx.balance_amount || 0);
        if (balanceAmount > 0) {
            if (tx.bill_type === 'patti_jawaak') {
                const delta = tx.is_return ? balanceAmount : -balanceAmount;
                await client.query(
                    'UPDATE parties SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [delta, tx.party_id]
                );
            } else {
                const delta = tx.is_return ? -balanceAmount : balanceAmount;
                await client.query(
                    'UPDATE parties SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [delta, tx.party_id]
                );
            }
        }

        // Delete patti transaction (items/expenses/payments will cascade)
        await client.query('DELETE FROM patti_transactions WHERE id = $1', [id]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Patti transaction reverted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error reverting patti transaction:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;
