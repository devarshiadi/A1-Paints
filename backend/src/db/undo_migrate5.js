const pool = require('./config');

if (process.env.I_REALLY_MEAN_IT !== 'YES') {
    console.error('REFUSING TO RUN: this script DROPS all patti_* tables — the entire patti (consignment) feature.');
    console.error('If this is truly what you want, re-run with:  I_REALLY_MEAN_IT=YES node src/db/undo_migrate5.js');
    process.exit(1);
}

const undoMigrate5 = async () => {
    const client = await pool.connect();

    try {
        console.log('🧹 Rolling back database migration (undo_migrate5)...');

        await client.query('BEGIN');

        await client.query('DROP TABLE IF EXISTS patti_payments CASCADE');
        await client.query('DROP TABLE IF EXISTS patti_expenses CASCADE');
        await client.query('DROP TABLE IF EXISTS patti_transaction_items CASCADE');
        await client.query('DROP TABLE IF EXISTS patti_transactions CASCADE');
        await client.query('DROP TABLE IF EXISTS patti_lots CASCADE');

        await client.query('COMMIT');
        console.log('✅ undo_migrate5 completed successfully!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ undo_migrate5 failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

undoMigrate5().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
