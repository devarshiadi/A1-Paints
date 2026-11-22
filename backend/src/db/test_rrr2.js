const pool = require('./config');

async function check() {
    try {
        const id = 'p-1773052654239'; // RRR_22TEST
        console.log('--- Transactions ---');
        let res = await pool.query(`SELECT id, total_amount FROM transactions WHERE party_id = $1`, [id]);
        console.log(res.rows);

        console.log('--- Patti Transactions ---');
        res = await pool.query(`SELECT id, total_amount FROM patti_transactions WHERE party_id = $1`, [id]);
        console.log(res.rows);

        console.log('--- Jama Entries ---');
        res = await pool.query(`SELECT id, amount FROM party_jama_entries WHERE party_id = $1`, [id]);
        console.log(res.rows);

    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
check();
