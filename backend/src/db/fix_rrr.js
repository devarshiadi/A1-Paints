const pool = require('./config');

async function fix() {
    try {
        await pool.query(`UPDATE parties SET current_balance = past_due WHERE name ILIKE '%RRR%'`);
        console.log('Fixed RRR_22TEST');
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
fix();
