const pool = require('./config');

async function check() {
    try {
        const res = await pool.query(`SELECT id, name, current_balance, past_due FROM parties WHERE name ILIKE '%RRR%'`);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
check();
