const { Pool } = require('pg');
const pool = require('./config');

async function testBal() {
    try {
        const idRes = await pool.query(`SELECT id, current_balance, past_due FROM parties WHERE name = 'A 1 मसाले'`);
        if (idRes.rows.length === 0) {
            console.log("Party not found");
            return;
        }
        const partyId = idRes.rows[0].id;
        console.log("Party State:", idRes.rows[0]);

        const txs = await pool.query(`SELECT id, bill_number, total_amount, paid_amount, balance_amount, is_return FROM transactions WHERE party_id = $1`, [partyId]);
        console.log("Txs:", txs.rows);

        const pmts = await pool.query(`SELECT p.id, p.mode, p.amount FROM payments p JOIN transactions t ON p.transaction_id = t.id WHERE t.party_id = $1`, [partyId]);
        console.log("Pmts:", pmts.rows);
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
testBal();
