const pool = require('./config');
const fs = require('fs');
const path = require('path');

async function backup() {
    const client = await pool.connect();
    try {
        console.log('Starting full backup before migrate8...\n');

        const outputDir = path.join(__dirname, '..', '..');

        // 1. Backup bill_counters (the table we're about to modify)
        const counters = await client.query('SELECT * FROM bill_counters ORDER BY prefix');
        console.log('=== BILL_COUNTERS (before migration) ===');
        counters.rows.forEach(r => console.log(`  ${r.prefix}: ${r.last_number}`));

        // 2. Full data dump of all tables
        const tables = [
            'parties', 'mirchi_types', 'lots', 'transactions', 'transaction_items',
            'expenses', 'payments', 'party_jama_entries', 'bill_counters',
            'patti_lots', 'patti_transactions', 'patti_transaction_items',
            'patti_expenses', 'patti_payments'
        ];

        console.log('\n=== TABLE COUNTS ===');
        const fullBackup = {};
        for (const table of tables) {
            try {
                const data = await client.query(`SELECT * FROM ${table}`);
                fullBackup[table] = data.rows;
                console.log(`  ${table}: ${data.rows.length} rows`);
            } catch (e) {
                fullBackup[table] = { error: e.message };
                console.log(`  ${table}: ERROR - ${e.message}`);
            }
        }

        const filename = `full_backup_before_migrate8_${new Date().toISOString().slice(0, 10)}.json`;
        fs.writeFileSync(path.join(outputDir, filename), JSON.stringify(fullBackup, null, 2));
        console.log(`\nSaved ${filename}`);
        console.log('Backup complete!\n');

    } catch (err) {
        console.error('Backup error:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

backup();
