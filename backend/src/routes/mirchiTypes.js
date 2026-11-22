const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const { v4: uuidv4 } = require('uuid');

// Product catalog API (stored in the legacy catalog table).
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM mirchi_types ORDER BY name ASC'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET mirchi type by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT * FROM mirchi_types WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching mirchi type:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST create or update a product.
router.post('/', async (req, res) => {
    const client = await pool.connect();

    try {
        const { id, name, current_rate, unit } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, message: 'Product name is required' });
        }

        const normalizedUnit = unit || 'kg';
        if (!['kg', 'liter'].includes(normalizedUnit)) {
            return res.status(400).json({ success: false, message: 'Unit must be kg or liter' });
        }

        const typeId = id || uuidv4();

        await client.query('BEGIN');

        // Check if type exists
        const existing = await client.query('SELECT id FROM mirchi_types WHERE id = $1', [typeId]);

        let result;
        if (existing.rows.length > 0) {
            // Update existing type
            result = await client.query(
                `UPDATE mirchi_types 
         SET name = $1, current_rate = $2, unit = $3, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $4 
         RETURNING *`,
                [name, current_rate || 0, normalizedUnit, typeId]
            );
        } else {
            // Insert new type
            result = await client.query(
                `INSERT INTO mirchi_types (id, name, current_rate, unit) 
         VALUES ($1, $2, $3, $4) 
         RETURNING *`,
                [typeId, name, current_rate || 0, normalizedUnit]
            );
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            data: result.rows[0],
            message: existing.rows.length > 0 ? 'Product updated successfully' : 'Product created successfully'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error saving product:', error);

        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ success: false, message: 'A product with this name already exists' });
        }

        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// DELETE product
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            'DELETE FROM mirchi_types WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        res.json({ success: true, message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Error deleting mirchi type:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
