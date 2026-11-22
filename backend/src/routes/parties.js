const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const { v4: uuidv4 } = require('uuid');

// GET all parties (paginated; ?search= matches name/phone/city; defaults preserve old behavior)
router.get('/', async (req, res) => {
    try {
        const search = (req.query.search || '').trim();

        const rawLimit = parseInt(req.query.limit ?? req.query.pageSize, 10);
        const rawPage = parseInt(req.query.page, 10);
        const rawOffset = parseInt(req.query.offset, 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 500;
        const offset = Number.isFinite(rawOffset) && rawOffset >= 0
            ? rawOffset
            : (Number.isFinite(rawPage) && rawPage > 0 ? (rawPage - 1) * limit : 0);

        const where = [];
        const params = [];
        if (search) {
            params.push(`%${search.toLowerCase()}%`);
            where.push(`(LOWER(name) LIKE $${params.length} OR LOWER(COALESCE(phone, '')) LIKE $${params.length} OR LOWER(COALESCE(city, '')) LIKE $${params.length})`);
        }
        const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

        const dataSql = `SELECT * FROM parties${whereSql} ORDER BY name ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        const countSql = `SELECT COUNT(*)::int AS total FROM parties${whereSql}`;

        const [dataRes, countRes] = await Promise.all([
            pool.query(dataSql, [...params, limit, offset]),
            pool.query(countSql, params),
        ]);
        const total = countRes.rows[0]?.total ?? 0;
        res.set('X-Total-Count', String(total));
        res.set('X-Page-Limit', String(limit));
        res.set('X-Page-Offset', String(offset));
        res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Page-Limit, X-Page-Offset');
        res.json(dataRes.rows);
    } catch (error) {
        console.error('Error fetching parties:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET party by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT * FROM parties WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Party not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching party:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST create or update party
router.post('/', async (req, res) => {
    const client = await pool.connect();

    try {
        const { id, name, phone, city, party_type, current_balance, past_due } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, message: 'Party name is required' });
        }

        const partyId = id || uuidv4();

        await client.query('BEGIN');

        // Check if party exists
        const existing = await client.query('SELECT id FROM parties WHERE id = $1', [partyId]);

        let result;
        if (existing.rows.length > 0) {
            // Update existing party
            result = await client.query(
                `UPDATE parties 
         SET name = $1, phone = $2, city = $3, party_type = $4, current_balance = $5, past_due = $6, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $7 
         RETURNING *`,
                [name, phone || '', city || '', party_type || 'both', current_balance || 0, past_due || 0, partyId]
            );
        } else {
            // Insert new party
            result = await client.query(
                `INSERT INTO parties (id, name, phone, city, party_type, current_balance, past_due) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING *`,
                [partyId, name, phone || '', city || '', party_type || 'both', current_balance || 0, past_due || 0]
            );
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            data: result.rows[0],
            message: existing.rows.length > 0 ? 'Party updated successfully' : 'Party created successfully'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error saving party:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// DELETE party
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            'DELETE FROM parties WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Party not found' });
        }

        res.json({ success: true, message: 'Party deleted successfully' });
    } catch (error) {
        console.error('Error deleting party:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
