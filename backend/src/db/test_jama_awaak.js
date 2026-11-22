/**
 * Round-trip test for Jama on an AWAAK (supplier) party.
 *   node src/db/test_jama_awaak.js
 *
 * The Party Ledger used to hide the Jama box for awaak parties, so payments
 * made TO a supplier could not be recorded there. The server side was always
 * correct — this proves it, so the frontend can stop gating it.
 *
 * Sign convention (routes/jama.js):
 *   awaak  → we owe them, stored as a NEGATIVE current_balance.
 *            Paying them moves the balance UP, toward zero.
 *   jawaak → they owe us, POSITIVE. A receipt moves it DOWN.
 *
 * Drives the real HTTP routes on a throwaway party, then deletes everything it
 * created. No existing row is touched.
 */
const assert = require('assert');
const express = require('express');
const pool = require('./config');

const app = express();
app.use(express.json());
app.use('/api/parties', require('../routes/parties'));
app.use('/api/jama', require('../routes/jama'));

const balanceOf = async (id) =>
    Number((await pool.query('SELECT current_balance FROM parties WHERE id = $1', [id])).rows[0].current_balance);

(async () => {
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body) => fetch(base + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json());

    const made = [];
    try {
        for (const [party_type, sign] of [['awaak', +1], ['jawaak', -1]]) {
            const id = `test-jama-${party_type}-${Date.now()}`;
            made.push(id);

            const created = await post('/api/parties', {
                id, name: `TEST ${party_type}`, party_type, current_balance: -5000, past_due: 0,
            });
            assert.ok(created.success, `could not create ${party_type} test party: ${created.message}`);
            assert.strictEqual(await balanceOf(id), -5000, 'party did not start at -5000');

            // Record a 2000 payment.
            const jama = await post(`/api/jama/${id}`, { amount: 2000, note: 'test' });
            assert.ok(jama.success, `jama rejected for ${party_type}: ${jama.message}`);

            const after = await balanceOf(id);
            const expected = -5000 + sign * 2000;
            assert.strictEqual(after, expected,
                `${party_type}: balance ${after}, expected ${expected}`);

            console.log(`✅ ${party_type.padEnd(6)} jama ₹2000: -5000 → ${after}` +
                (sign > 0 ? '  (payable reduced, toward zero)' : '  (receivable reduced)'));

            // Reverting must put it back exactly.
            const del = await fetch(`${base}/api/jama/${id}/${jama.data.id}`, { method: 'DELETE' }).then(r => r.json());
            assert.ok(del.success, `revert failed: ${del.message}`);
            assert.strictEqual(await balanceOf(id), -5000, `${party_type}: revert did not restore the balance`);
        }

        console.log('✅ jama works for awaak and jawaak, and reverts cleanly for both');
    } finally {
        for (const id of made) {
            await pool.query('DELETE FROM party_jama_entries WHERE party_id = $1', [id]);
            await pool.query('DELETE FROM parties WHERE id = $1', [id]);
        }
        server.close();
        await pool.end();
    }
})();
