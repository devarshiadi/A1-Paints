/**
 * POST /api/invoice-image/:id
 *
 * Accepts an `image/png` body and persists it to the configured invoice
 * image directory (HF Spaces persistent storage at /data/invoices in prod,
 * a local .cache/invoices in dev). The /invoice/og-image/:id.png reader
 * (in invoice-view.js) prefers the uploaded file over the canvas fallback,
 * so WhatsApp's link-preview crawler ends up serving whatever pixels the
 * frontend rendered via html2canvas — guaranteeing the WhatsApp card
 * matches the in-app invoice exactly.
 *
 * Auth: open. The id-exists check below prevents random POSTs from piling
 * up garbage files on the volume. This matches the "temporary" deterrent
 * posture established by the frontend LoginGate; replace with real auth
 * when the rest of the API gets it.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db/config');

const router = express.Router();

const STORAGE_DIR = process.env.INVOICE_IMAGE_DIR
    || (fs.existsSync('/data') ? '/data/invoices'
                                : path.join(__dirname, '..', '..', '.cache', 'invoices'));

// Create on boot so the first upload doesn't race the mkdir.
try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    console.log(`[invoice-image-upload] storage dir: ${STORAGE_DIR}`);
} catch (e) {
    console.warn(`[invoice-image-upload] mkdir ${STORAGE_DIR} failed:`, e.message);
}

router.post(
    '/:id',
    express.raw({ type: 'image/png', limit: '6mb' }),
    async (req, res) => {
        try {
            const { id } = req.params;
            if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
                return res.status(400).json({ success: false, message: 'invalid id' });
            }
            if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
                return res.status(400).json({ success: false, message: 'empty body — set Content-Type: image/png' });
            }

            // Cheap existence check so a script can't fill the volume with /api/invoice-image/aaaaa1.png …
            const sql = id.endsWith('-patti')
                ? 'SELECT 1 FROM patti_transactions WHERE id = $1'
                : 'SELECT 1 FROM transactions WHERE id = $1';
            const found = await pool.query(sql, [id]);
            if (found.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'transaction not found' });
            }

            await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
            const filePath = path.join(STORAGE_DIR, `${id}.png`);
            await fs.promises.writeFile(filePath, req.body);

            res.json({
                success: true,
                bytes: req.body.length,
                url: `/invoice/og-image/${encodeURIComponent(id)}.png`,
            });
        } catch (err) {
            console.error('[invoice-image-upload] error:', err);
            res.status(500).json({ success: false, message: err.message });
        }
    },
);

module.exports = router;
module.exports.STORAGE_DIR = STORAGE_DIR;
