const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const { v4: uuidv4 } = require('uuid');
// Shared SQL — computes party's outstanding running balance just before this
// bill (chronological walk of prior bills/jama). Required for accurate
// Magil Baki on invoices. See pdf.js for the full definition.
const { BALANCE_BEFORE_BILL_SQL } = require('./pdf');
const { deductStock, addStock } = require('../db/stock');

// Fetch the complete transaction with items, expenses, and payments.
// party_past_due + party_balance_before_bill are what the invoice prints
// as Magil Baki. They MUST be here: the bill screen prints straight from
// this response, and when these were missing the invoice quietly showed
// Magil Baki ₹0.00 while the ledger showed the real figure for the same
// bill. Same columns as GET / and GET /:id — keep all three in step.
const COMPLETE_TRANSACTION_SQL = `
            SELECT t.*,
                   pa.phone           AS party_phone,
                   pa.past_due        AS party_past_due,
                   pa.current_balance AS party_current_balance,
                   (${BALANCE_BEFORE_BILL_SQL}) AS party_balance_before_bill,
                   json_agg(DISTINCT jsonb_build_object(
                     'id', ti.id,
                     'product_id', ti.mirchi_type_id,
                     'mirchi_type_id', ti.mirchi_type_id,
                     'product_name', ti.mirchi_name,
                     'mirchi_name', ti.mirchi_name,
                     'quality', ti.quality,
                     'unit', ti.unit,
                     'lot_id', ti.lot_id,
                     'lot_number', l.lot_number,
                     'poti_weights', ti.poti_weights,
                     'gross_weight', ti.gross_weight,
                     'poti_count', ti.poti_count,
                     'total_potya', ti.total_potya,
                     'net_weight', ti.net_weight,
                     'rate_per_kg', ti.rate_per_kg,
                     'item_total', ti.item_total
                   )) FILTER (WHERE ti.id IS NOT NULL) as items,
                   json_build_object(
                     'cess_percent', e.cess_percent,
                     'cess_amount', e.cess_amount,
                     'adat_percent', e.adat_percent,
                     'adat_amount', e.adat_amount,
                     'poti_rate', e.poti_rate,
                     'poti_amount', e.poti_amount,
                     'hamali_per_poti', e.hamali_per_poti,
                     'hamali_amount', e.hamali_amount,
                     'packaging_hamali_per_poti', e.packaging_hamali_per_poti,
                     'packaging_hamali_amount', e.packaging_hamali_amount,
                     'gaadi_bharni', e.gaadi_bharni,
                     'other_expenses', e.other_expenses
                   ) as expenses,
                   json_agg(DISTINCT jsonb_build_object(
                     'mode', p.mode,
                     'amount', p.amount,
                     'reference', p.reference
                   )) FILTER (WHERE p.id IS NOT NULL) as payments
            FROM transactions t
            LEFT JOIN parties pa ON pa.id = t.party_id
            LEFT JOIN transaction_items ti ON t.id = ti.transaction_id
            LEFT JOIN lots l ON ti.lot_id = l.id
            LEFT JOIN expenses e ON t.id = e.transaction_id
            LEFT JOIN payments p ON t.id = p.transaction_id
            WHERE t.id = $1
            GROUP BY t.id, e.id, pa.id
`;

// Helper function to format bill number based on sequence
function formatBillNumber(prefix, number) {
    // First batch: 1-500 → A-001 to A-500
    if (number <= 500) {
        return `${prefix}-${String(number).padStart(3, '0')}`;
    }

    // After 500, generate batches of 500:
    // 501..1000  => A-A01..A-A500
    // 1001..1500 => A-B01..A-B500
    // ... then AA, AB, etc.
    const afterFirstBatch = number - 500;

    const batchIndex = Math.floor((afterFirstBatch - 1) / 500) + 1; // 1 => A, 2 => B, ...
    const withinBatch = ((afterFirstBatch - 1) % 500) + 1; // 1..500

    // Convert batchIndex (1-based) to letters: 1=A, 2=B, ... 26=Z, 27=AA...
    let letters = '';
    let n = batchIndex;
    while (n > 0) {
        n--;
        letters = String.fromCharCode(65 + (n % 26)) + letters;
        n = Math.floor(n / 26);
    }

    return `${prefix}-${letters}${String(withinBatch).padStart(2, '0')}`;
}

// GET next sequential bill number from DB
// Single global counter — all bill types share one sequence: 1, 2, 3, 4...
router.get('/next-bill-number', async (req, res) => {
    const client = await pool.connect();
    try {
        const { type, isReturn } = req.query;

        // Display prefix based on type (just for labelling, not for counter)
        let prefix;
        if (type === 'patti_jawaak') {
            prefix = isReturn === 'true' ? 'J-RET' : 'J';
        } else if (type === 'patti_awaak') {
            prefix = isReturn === 'true' ? 'A-RET' : 'A';
        } else if (type === 'jawaak') {
            prefix = isReturn === 'true' ? 'J-RET' : 'J';
        } else {
            prefix = isReturn === 'true' ? 'A-RET' : 'A';
        }

        // ONE global counter for all bill types — ensures strict sequential order
        const counterPrefix = 'BILL';

        // Atomic increment + return
        const result = await client.query(
            `INSERT INTO bill_counters (prefix, last_number) VALUES ($1, 1)
             ON CONFLICT (prefix) DO UPDATE SET last_number = bill_counters.last_number + 1, updated_at = CURRENT_TIMESTAMP
             RETURNING last_number`,
            [counterPrefix]
        );

        const nextNumber = result.rows[0].last_number;
        const formattedBillNumber = formatBillNumber(prefix, nextNumber);

        res.json({
            success: true,
            bill_number: formattedBillNumber,
            prefix: prefix,
            count: nextNumber,
            formatted: formattedBillNumber
        });
    } catch (error) {
        console.error('Error generating bill number:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// GET all transactions (paginated). Defaults preserve old behavior:
// no params => returns up to 200 newest rows. Pass ?limit=&offset= or
// ?page=&pageSize= for explicit windowing. Total row count is returned
// in the X-Total-Count header so the client can render a Prev/Next UI
// without parsing the body.
router.get('/', async (req, res) => {
    try {
        const { party_id, bill_type, is_return } = req.query;

        const rawLimit = parseInt(req.query.limit ?? req.query.pageSize, 10);
        const rawPage = parseInt(req.query.page, 10);
        const rawOffset = parseInt(req.query.offset, 10);

        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
        const offset = Number.isFinite(rawOffset) && rawOffset >= 0
            ? rawOffset
            : (Number.isFinite(rawPage) && rawPage > 0 ? (rawPage - 1) * limit : 0);

        // Lateral subqueries instead of LEFT JOIN + GROUP BY: avoids row
        // multiplication when a tx has multiple items AND multiple payments.
        // Also denormalises party_phone / party_past_due / party_current_balance
        // for the invoice WhatsApp share + Magil Baki feature.
        let query = `
      SELECT t.*,
             pa.phone           AS party_phone,
             pa.past_due        AS party_past_due,
             pa.current_balance AS party_current_balance,
             (${BALANCE_BEFORE_BILL_SQL}) AS party_balance_before_bill,
             COALESCE((
                 SELECT json_agg(jsonb_build_object(
                     'id', ti.id,
                     'product_id', ti.mirchi_type_id,
                     'mirchi_type_id', ti.mirchi_type_id,
                     'product_name', ti.mirchi_name,
                     'mirchi_name', ti.mirchi_name,
                     'quality', ti.quality,
                     'unit', ti.unit,
                     'lot_id', ti.lot_id,
                     'lot_number', l.lot_number,
                     'poti_weights', ti.poti_weights,
                     'gross_weight', ti.gross_weight,
                     'poti_count', ti.poti_count,
                     'total_potya', ti.total_potya,
                     'net_weight', ti.net_weight,
                     'rate_per_kg', ti.rate_per_kg,
                     'item_total', ti.item_total
                 ))
                 FROM transaction_items ti
                 LEFT JOIN lots l ON ti.lot_id = l.id
                 WHERE ti.transaction_id = t.id
             ), '[]'::json) AS items,
             COALESCE((
                 SELECT json_build_object(
                     'cess_percent', e.cess_percent,
                     'cess_amount', e.cess_amount,
                     'adat_percent', e.adat_percent,
                     'adat_amount', e.adat_amount,
                     'poti_rate', e.poti_rate,
                     'poti_amount', e.poti_amount,
                     'hamali_per_poti', e.hamali_per_poti,
                     'hamali_amount', e.hamali_amount,
                     'packaging_hamali_per_poti', e.packaging_hamali_per_poti,
                     'packaging_hamali_amount', e.packaging_hamali_amount,
                     'gaadi_bharni', e.gaadi_bharni,
                     'gaadi_number', e.gaadi_number,
                     'other_expenses', e.other_expenses
                 )
                 FROM expenses e
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
                 FROM payments p
                 WHERE p.transaction_id = t.id
             ), '[]'::json) AS payments
      FROM transactions t
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

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        // Count total rows matching the same WHERE clause (cheap — no joins).
        let countQuery = 'SELECT COUNT(*)::int AS total FROM transactions t';
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
        console.error('Error fetching transactions:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET transaction by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
      SELECT t.*,
             pa.phone           AS party_phone,
             pa.past_due        AS party_past_due,
             pa.current_balance AS party_current_balance,
             (${BALANCE_BEFORE_BILL_SQL}) AS party_balance_before_bill,
             COALESCE((
                 SELECT json_agg(jsonb_build_object(
                     'id', ti.id,
                     'product_id', ti.mirchi_type_id,
                     'mirchi_type_id', ti.mirchi_type_id,
                     'product_name', ti.mirchi_name,
                     'mirchi_name', ti.mirchi_name,
                     'quality', ti.quality,
                     'unit', ti.unit,
                     'lot_id', ti.lot_id,
                     'lot_number', l.lot_number,
                     'poti_weights', ti.poti_weights,
                     'gross_weight', ti.gross_weight,
                     'poti_count', ti.poti_count,
                     'total_potya', ti.total_potya,
                     'net_weight', ti.net_weight,
                     'rate_per_kg', ti.rate_per_kg,
                     'item_total', ti.item_total
                 ))
                 FROM transaction_items ti
                 LEFT JOIN lots l ON ti.lot_id = l.id
                 WHERE ti.transaction_id = t.id
             ), '[]'::json) AS items,
             COALESCE((
                 SELECT json_build_object(
                     'cess_percent', e.cess_percent,
                     'cess_amount', e.cess_amount,
                     'adat_percent', e.adat_percent,
                     'adat_amount', e.adat_amount,
                     'poti_rate', e.poti_rate,
                     'poti_amount', e.poti_amount,
                     'hamali_per_poti', e.hamali_per_poti,
                     'hamali_amount', e.hamali_amount,
                     'packaging_hamali_per_poti', e.packaging_hamali_per_poti,
                     'packaging_hamali_amount', e.packaging_hamali_amount,
                     'gaadi_bharni', e.gaadi_bharni,
                     'gaadi_number', e.gaadi_number,
                     'other_expenses', e.other_expenses
                 )
                 FROM expenses e
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
                 FROM payments p
                 WHERE p.transaction_id = t.id
             ), '[]'::json) AS payments
      FROM transactions t
      LEFT JOIN parties pa ON pa.id = t.party_id
      WHERE t.id = $1
    `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching transaction:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST create transaction
router.post('/', async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            id,
            bill_date,
            bill_type,
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
            balance_amount
        } = req.body;

        // Validation
        if (!party_id) {
            return res.status(400).json({ success: false, message: 'Party is required' });
        }

        if (!items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'At least one item is required' });
        }

        await client.query('BEGIN');

        // Bill number resolution — prefer the one the frontend already reserved
        // via GET /next-bill-number. Generating again here would double-increment
        // the counter and leave a gap in the sequence for every regular save.
        // Only fall back to atomic generation if no valid bill_number was sent.
        let bill_number = typeof req.body.bill_number === 'string' ? req.body.bill_number.trim() : '';
        if (!bill_number) {
            let prefix;
            if (bill_type === 'jawaak') {
                prefix = is_return ? 'J-RET' : 'J';
            } else {
                prefix = is_return ? 'A-RET' : 'A';
            }
            const counterResult = await client.query(
                `INSERT INTO bill_counters (prefix, last_number) VALUES ('BILL', 1)
                 ON CONFLICT (prefix) DO UPDATE SET last_number = bill_counters.last_number + 1, updated_at = CURRENT_TIMESTAMP
                 RETURNING last_number`,
                []
            );
            bill_number = formatBillNumber(prefix, counterResult.rows[0].last_number);
        }

        const transactionId = id || uuidv4();

        console.log('=== BACKEND: SAVING TRANSACTION ===');
        console.log('Transaction ID:', transactionId);
        console.log('Bill Number:', bill_number);
        console.log('Items received:', items?.length);

        // 1. Insert transaction
        const txResult = await client.query(
            `INSERT INTO transactions (
        id, bill_number, bill_date, bill_type, is_return, party_id, party_name, invoice_group_id,
        gross_weight_total, net_weight_total, subtotal, total_expenses,
        total_amount, paid_amount, balance_amount
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
            [
                transactionId, bill_number, bill_date, bill_type, is_return || false,
                party_id, party_name, invoice_group_id || null, gross_weight_total, net_weight_total,
                subtotal, total_expenses, total_amount, paid_amount, balance_amount
            ]
        );

        // 2. Insert transaction items
        console.log('=== INSERTING ITEMS ===');
        for (const item of items) {
            const itemId = item.id || uuidv4();
            item.id = itemId;
            console.log('Inserting item:', itemId, item.mirchi_name);
            const productId = item.mirchi_type_id || item.product_id;
            const productName = item.mirchi_name || item.product_name;
            const product = await client.query('SELECT unit FROM mirchi_types WHERE id = $1', [productId]);
            if (!product.rows.length) throw new Error(`Unknown product: ${productId}`);
            await client.query(
                `INSERT INTO transaction_items (
          id, transaction_id, mirchi_type_id, mirchi_name, quality, lot_id, unit,
          poti_weights, gross_weight, poti_count, total_potya, net_weight,
          rate_per_kg, item_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                [
                    itemId, transactionId, productId, productName,
                    item.quality, item.lot_id, product.rows[0].unit, JSON.stringify(item.poti_weights),
                    item.gross_weight, item.poti_count, item.total_potya,
                    item.net_weight, item.rate_per_kg, item.item_total
                ]
            );
        }
        console.log('=== ITEMS INSERTED ===');

        // 3. Insert expenses
        if (expenses) {
            await client.query(
                `INSERT INTO expenses (
          transaction_id, cess_percent, cess_amount, adat_percent, adat_amount,
          poti_rate, poti_amount, hamali_per_poti, hamali_amount,
          packaging_hamali_per_poti, packaging_hamali_amount, gaadi_bharni, gaadi_number, other_expenses
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                [
                    transactionId, expenses.cess_percent || 0, expenses.cess_amount || 0,
                    expenses.adat_percent || 0, expenses.adat_amount || 0,
                    expenses.poti_rate || 0, expenses.poti_amount || 0,
                    expenses.hamali_per_poti || 0, expenses.hamali_amount || 0,
                    expenses.packaging_hamali_per_poti || 0, expenses.packaging_hamali_amount || 0,
                    expenses.gaadi_bharni || 0, expenses.gaadi_number || null, expenses.other_expenses || 0
                ]
            );
        }

        // 4. Insert payments
        if (payments && payments.length > 0) {
            for (const payment of payments) {
                if (payment.amount > 0) {
                    await client.query(
                        `INSERT INTO payments (transaction_id, mode, amount, reference)
             VALUES ($1, $2, $3, $4)`,
                        [transactionId, payment.mode, payment.amount, payment.reference]
                    );
                }
            }
        }

        // 5. Update party balance
        // Convention: +ve = they owe us (receivable), -ve = we owe them (payable)
        // JAWAAK (sales): increases receivable (+). AWAAK (purchase): increases payable (-).
        const sign = bill_type === 'jawaak' ? 1 : -1;
        const dir = is_return ? -1 : 1;
        const balanceDelta = sign * dir * balance_amount;

        await client.query(
            'UPDATE parties SET current_balance = current_balance + $1 WHERE id = $2',
            [balanceDelta, party_id]
        );

        // 6. Update lots (stock management) in each product's configured unit.
        // net_weight is the entered quantity in kg or liter.
        // AWAAK = Purchase (Stock IN), JAWAAK = Sale (Stock OUT)
        if (bill_type === 'awaak' && !is_return) {
            // Purchase: Create new lots or update existing ones
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const quantity = Number(item.net_weight) || 0;
                const productId = item.mirchi_type_id || item.product_id;
                const product = await client.query('SELECT name, unit FROM mirchi_types WHERE id = $1', [productId]);
                const productName = product.rows[0]?.name || item.product_name || item.mirchi_name || 'Unknown';
                const unit = product.rows[0]?.unit || 'kg';

                // Check if lot_number is provided (user-entered or selected existing)
                if (item.lot_number) {
                    // Check if lot already exists
                    const existingLot = await client.query(
                        'SELECT id, mirchi_type_id, unit FROM lots WHERE lot_number = $1',
                        [item.lot_number]
                    );

                    if (existingLot.rows.length > 0) {
                        const existing = existingLot.rows[0];
                        if (existing.mirchi_type_id !== productId || existing.unit !== unit) {
                            const err = new Error('The selected lot belongs to a different product or unit');
                            err.statusCode = 400;
                            throw err;
                        }
                        // Update existing lot - add bags
                        const lotId = existing.id;
                        await client.query(
                            `UPDATE lots
                             SET total_quantity = total_quantity + $1,
                                 remaining_quantity = remaining_quantity + $1,
                                 status = 'active',
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = $2`,
                            [quantity, lotId]
                        );

                        // Update item with lot_id
                        await client.query(
                            'UPDATE transaction_items SET lot_id = $1 WHERE id = $2',
                            [lotId, item.id || uuidv4()]
                        );
                    } else {
                        // Create new lot with user-provided lot_number — total/remaining stored as BAGS
                        const lotId = uuidv4();
                        await client.query(
                            `INSERT INTO lots (id, lot_number, mirchi_type_id, mirchi_name, unit, total_quantity, remaining_quantity, purchase_date, status, avg_rate)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                            [lotId, item.lot_number, productId, productName, unit, quantity, quantity, bill_date, 'active', item.rate_per_kg]
                        );

                        // Update item with lot_id
                        await client.query(
                            'UPDATE transaction_items SET lot_id = $1 WHERE id = $2',
                            [lotId, item.id || uuidv4()]
                        );
                    }
                }
            }
        } else if (bill_type === 'awaak' && is_return) {
            // Purchase Return (returning to supplier): bags leave the shop
            for (const item of items) {
                if (item.lot_id) {
                    const quantity = Number(item.net_weight) || 0;
                    await deductStock(client, 'lots', item.lot_id, quantity, { alsoTotal: true });
                }
            }
        } else if (bill_type === 'jawaak' && !is_return) {
            // Sale: deduct bags from selected lot
            for (const item of items) {
                if (item.lot_id) {
                    const quantity = Number(item.net_weight) || 0;
                    await deductStock(client, 'lots', item.lot_id, quantity);
                }
            }
        } else if (bill_type === 'jawaak' && is_return) {
            // Sales Return (customer brings goods back): bags come back into the shop
            for (const item of items) {
                if (item.lot_id) {
                    const quantity = Number(item.net_weight) || 0;
                    await addStock(client, 'lots', item.lot_id, quantity);
                }
            }
        }

        await client.query('COMMIT');

        const completeTransaction = await client.query(COMPLETE_TRANSACTION_SQL, [transactionId]);

        res.json({
            success: true,
            data: completeTransaction.rows[0],
            message: 'Transaction saved successfully'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error saving transaction:', error);
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// PATCH update transaction payment
router.patch('/:id/payment', async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
        }

        await client.query('BEGIN');

        // Get transaction
        const txResult = await client.query(
            'SELECT * FROM transactions WHERE id = $1',
            [id]
        );

        if (txResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        const tx = txResult.rows[0];

        if (amount > parseFloat(tx.balance_amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: `Amount (${amount}) exceeds due balance (${tx.balance_amount})` });
        }

        // Update transaction
        await client.query(
            `UPDATE transactions 
       SET paid_amount = paid_amount + $1, 
           balance_amount = balance_amount - $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
            [amount, id]
        );

        // Add payment record
        await client.query(
            `INSERT INTO payments (transaction_id, mode, amount, reference)
       VALUES ($1, $2, $3, $4)`,
            [id, 'cash', amount, `Due Payment - ${new Date().toLocaleDateString()}`]
        );

        // Update party balance
        if (tx.bill_type === 'awaak') {
            // Purchase: Reduce payable
            await client.query(
                'UPDATE parties SET current_balance = current_balance + $1 WHERE id = $2',
                [amount, tx.party_id]
            );
        } else {
            // Sales: Reduce receivable
            await client.query(
                'UPDATE parties SET current_balance = current_balance - $1 WHERE id = $2',
                [amount, tx.party_id]
            );
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Payment updated successfully'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating payment:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// POST revert transaction (rollback stock + balances, then delete)
router.post('/:id/revert', async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;

        await client.query('BEGIN');

        const txResult = await client.query(
            'SELECT * FROM transactions WHERE id = $1',
            [id]
        );

        if (txResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        const tx = txResult.rows[0];

        const itemsResult = await client.query(
            'SELECT * FROM transaction_items WHERE transaction_id = $1',
            [id]
        );

        const items = itemsResult.rows;

        if (!items || items.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'No items found for this transaction' });
        }

        // Rollback lots (inverse of creation logic)
        for (const item of items) {
            if (!item.lot_id) continue;

            const lotResult = await client.query(
                'SELECT * FROM lots WHERE id = $1',
                [item.lot_id]
            );

            if (lotResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, message: `Lot not found for item ${item.id}` });
            }

            const lot = lotResult.rows[0];
            const quantity = Number(item.net_weight) || 0;

            // Stock quantity is measured in the product unit, not package count.
            // AWAAK = Purchase (Stock IN), JAWAAK = Sale (Stock OUT)
            if (tx.bill_type === 'awaak' && !tx.is_return) {
                // Reverting a purchase: subtract bags that were added
                if (Number(lot.remaining_quantity) < quantity || Number(lot.total_quantity) < quantity) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({
                        success: false,
                        message: `Cannot revert: stock already used for lot ${lot.lot_number}. Remaining ${lot.remaining_quantity} ${lot.unit || 'units'}, required ${quantity} ${lot.unit || 'units'}`
                    });
                }

                await client.query(
                    `UPDATE lots
                     SET total_quantity = total_quantity - $1,
                         remaining_quantity = remaining_quantity - $1,
                         status = CASE WHEN remaining_quantity - $1 <= 0 THEN 'sold_out' ELSE 'active' END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [quantity, item.lot_id]
                );
            } else if (tx.bill_type === 'awaak' && tx.is_return) {
                // Reverting a purchase return: add bags back
                await client.query(
                    `UPDATE lots
                     SET total_quantity = total_quantity + $1,
                         remaining_quantity = remaining_quantity + $1,
                         status = 'active',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [quantity, item.lot_id]
                );
            } else if (tx.bill_type === 'jawaak' && !tx.is_return) {
                // Reverting a sale: add bags back to remaining
                await client.query(
                    `UPDATE lots
                     SET remaining_quantity = remaining_quantity + $1,
                         status = CASE WHEN remaining_quantity + $1 > 0 THEN 'active' ELSE status END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [quantity, item.lot_id]
                );
            } else if (tx.bill_type === 'jawaak' && tx.is_return) {
                // Reverting a sales return: subtract bags that were added back
                if (Number(lot.remaining_quantity) < quantity) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({
                        success: false,
                        message: `Cannot revert: not enough remaining stock in lot ${lot.lot_number}. Remaining ${lot.remaining_quantity} ${lot.unit || 'units'}, required ${quantity} ${lot.unit || 'units'}`
                    });
                }

                await client.query(
                    `UPDATE lots
                     SET remaining_quantity = remaining_quantity - $1,
                         status = CASE WHEN remaining_quantity - $1 <= 0 THEN 'sold_out' ELSE 'active' END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [quantity, item.lot_id]
                );
            }
        }

        // Rollback party balance (inverse of creation logic in this file)
        const balanceAmount = Number(tx.balance_amount || 0);

        if (tx.bill_type === 'jawaak') {
            if (tx.is_return) {
                await client.query(
                    'UPDATE parties SET current_balance = current_balance + $1 WHERE id = $2',
                    [balanceAmount, tx.party_id]
                );
            } else {
                await client.query(
                    'UPDATE parties SET current_balance = current_balance - $1 WHERE id = $2',
                    [balanceAmount, tx.party_id]
                );
            }
        } else {
            if (tx.is_return) {
                await client.query(
                    'UPDATE parties SET current_balance = current_balance - $1 WHERE id = $2',
                    [balanceAmount, tx.party_id]
                );
            } else {
                await client.query(
                    'UPDATE parties SET current_balance = current_balance + $1 WHERE id = $2',
                    [balanceAmount, tx.party_id]
                );
            }
        }

        // Delete transaction (items/expenses/payments will cascade delete)
        await client.query('DELETE FROM transactions WHERE id = $1', [id]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Transaction reverted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error reverting transaction:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;
module.exports.COMPLETE_TRANSACTION_SQL = COMPLETE_TRANSACTION_SQL;
