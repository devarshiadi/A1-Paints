const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const { v4: uuidv4 } = require('uuid');

// GET jama entries for a party (paginated)
router.get('/:partyId', async (req, res) => {
    try {
        const { partyId } = req.params;

        const rawLimit = parseInt(req.query.limit ?? req.query.pageSize, 10);
        const rawPage = parseInt(req.query.page, 10);
        const rawOffset = parseInt(req.query.offset, 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
        const offset = Number.isFinite(rawOffset) && rawOffset >= 0
            ? rawOffset
            : (Number.isFinite(rawPage) && rawPage > 0 ? (rawPage - 1) * limit : 0);

        const [dataRes, countRes] = await Promise.all([
            pool.query(
                `SELECT id, party_id, entry_date, amount, note, created_at
                 FROM party_jama_entries
                 WHERE party_id = $1
                 ORDER BY entry_date ASC, created_at ASC
                 LIMIT $2 OFFSET $3`,
                [partyId, limit, offset]
            ),
            pool.query(
                'SELECT COUNT(*)::int AS total FROM party_jama_entries WHERE party_id = $1',
                [partyId]
            ),
        ]);
        const total = countRes.rows[0]?.total ?? 0;
        res.set('X-Total-Count', String(total));
        res.set('X-Page-Limit', String(limit));
        res.set('X-Page-Offset', String(offset));
        res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Page-Limit, X-Page-Offset');
        res.json({ success: true, data: dataRes.rows });
    } catch (error) {
        console.error('Error fetching jama entries:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST create jama entry for a party (overall receipt)
router.post('/:partyId', async (req, res) => {
    const client = await pool.connect();

    try {
        const { partyId } = req.params;
        const { amount, entry_date, note } = req.body;

        const parsed = typeof amount === 'number' ? amount : parseFloat(String(amount));
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
        }

        await client.query('BEGIN');

        // ensure party exists
        const partyRes = await client.query('SELECT id, current_balance, party_type FROM parties WHERE id = $1', [partyId]);
        if (partyRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Party not found' });
        }

        const id = uuidv4();
        const date = entry_date || new Date().toISOString().split('T')[0];

        const insertRes = await client.query(
            `INSERT INTO party_jama_entries (id, party_id, entry_date, amount, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, party_id, entry_date, amount, note, created_at`,
            [id, partyId, date, parsed, note || null]
        );

        // JAWAAK (sales) party: receipt reduces receivable → current_balance goes down.
        // AWAAK (purchase) party: payment to supplier reduces payable, which is stored
        // as a negative current_balance → current_balance goes up (toward zero).
        const sign = partyRes.rows[0].party_type === 'awaak' ? +1 : -1;
        await client.query(
            'UPDATE parties SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [sign * parsed, partyId]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            data: insertRes.rows[0],
            message: 'Jama saved successfully'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating jama entry:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// DELETE revert jama entry
router.delete('/:partyId/:entryId', async (req, res) => {
    const client = await pool.connect();

    try {
        const { partyId, entryId } = req.params;

        await client.query('BEGIN');

        const entryRes = await client.query(
            `SELECT j.id, j.party_id, j.amount, p.party_type
               FROM party_jama_entries j
               JOIN parties p ON p.id = j.party_id
              WHERE j.id = $1 AND j.party_id = $2`,
            [entryId, partyId]
        );

        if (entryRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Jama entry not found' });
        }

        const amtRaw = entryRes.rows[0].amount;
        const amt = typeof amtRaw === 'number' ? amtRaw : parseFloat(String(amtRaw)) || 0;

        await client.query('DELETE FROM party_jama_entries WHERE id = $1 AND party_id = $2', [entryId, partyId]);

        // Reverse the sign applied in POST: awaak → undo +amt, jawaak → undo -amt.
        const sign = entryRes.rows[0].party_type === 'awaak' ? -1 : +1;
        await client.query(
            'UPDATE parties SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [sign * amt, partyId]
        );

        await client.query('COMMIT');

        res.json({ success: true, message: 'Jama reverted successfully' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error reverting jama entry:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;
