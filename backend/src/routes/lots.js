const express = require('express');
const router = express.Router();
const pool = require('../db/config');

// GET all lots
router.get('/', async (req, res) => {
    try {
        const { status } = req.query;

        let query = 'SELECT * FROM lots ORDER BY purchase_date DESC';
        let params = [];

        if (status) {
            query = 'SELECT * FROM lots WHERE status = $1 ORDER BY purchase_date DESC';
            params = [status];
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching lots:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET active lots with remaining quantity
router.get('/active', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM lots 
       WHERE status = 'active' AND remaining_quantity > 0 
       ORDER BY purchase_date DESC`
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching active lots:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET lot by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT * FROM lots WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lot not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching lot:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET lots by mirchi type
router.get('/mirchi/:mirchiTypeId', async (req, res) => {
    try {
        const { mirchiTypeId } = req.params;
        const result = await pool.query(
            `SELECT * FROM lots 
       WHERE mirchi_type_id = $1 
       ORDER BY purchase_date DESC`,
            [mirchiTypeId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching lots by mirchi type:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST check if lot number is unique
router.post('/check-unique', async (req, res) => {
    try {
        const { lot_number } = req.body;

        if (!lot_number) {
            return res.status(400).json({ success: false, message: 'Lot number is required' });
        }

        const result = await pool.query(
            'SELECT id FROM lots WHERE lot_number = $1',
            [lot_number]
        );

        res.json({ exists: result.rows.length > 0 });
    } catch (error) {
        console.error('Error checking lot uniqueness:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET available lots for a mirchi type (with remaining bags > 0)
// remaining_quantity is BAG COUNT after migration to bag-based stock tracking.
router.get('/available/:mirchiTypeId', async (req, res) => {
    try {
        const { mirchiTypeId } = req.params;
        const result = await pool.query(
            `SELECT *,
                    remaining_quantity AS poti_count
             FROM lots
             WHERE mirchi_type_id = $1
             AND status = 'active'
             AND remaining_quantity > 0
             ORDER BY purchase_date DESC`,
            [mirchiTypeId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching available lots:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Remove a stock lot from sellable stock (soft delete — keeps all history intact).
// Marks it sold_out with 0 remaining so it drops out of the available-stock dropdown.
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `UPDATE lots
             SET status = 'sold_out', remaining_quantity = 0, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING id`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lot not found' });
        }
        res.json({ success: true, message: 'Lot removed from stock' });
    } catch (error) {
        console.error('Error removing lot:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
