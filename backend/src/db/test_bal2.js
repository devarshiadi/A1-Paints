const pool = require('./config');

async function testBal2() {
    try {
        const patti = await pool.query(`SELECT id, bill_number, total_amount, paid_amount, balance_amount FROM patti_transactions WHERE party_id = 'p-1766918507681'`);
        console.log("Patti Txs:", patti.rows);

        const pmts = await pool.query(`SELECT id, amount, entry_date FROM party_jama_entries WHERE party_id = 'p-1766918507681'`);
        console.log("Jama Entries:", pmts.rows);
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
testBal2();
