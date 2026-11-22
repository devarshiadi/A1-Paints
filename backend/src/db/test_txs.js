const pool = require('./config');

async function check() {
    try {
        console.log('--- ALL PARTIES ---');
        let res = await pool.query(`SELECT id, name, current_balance, past_due FROM parties WHERE current_balance != 0 OR past_due != 0`);
        console.log(JSON.stringify(res.rows, null, 2));

        console.log('--- ALL TRANSACTIONS ---');
        res = await pool.query(`SELECT id, party_id, bill_number, bill_type, total_amount, paid_amount, balance_amount FROM transactions`);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
check();
