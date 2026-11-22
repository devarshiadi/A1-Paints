const { Pool } = require('pg');
const fs = require('fs');

const config = {
    user: "avnadmin",
    password: "AVNS_8YN2lShyUCy56qezi-_",
    host: "staging-photobrex-3b7a.j.aivencloud.com",
    port: 10838,
    database: "defaultdb",
    ssl: { rejectUnauthorized: false },
};

const pool = new Pool(config);

async function backup() {
    const client = await pool.connect();
    try {
        // 1. Export party names and contacts
        const parties = await client.query('SELECT id, name, phone, city, party_type, current_balance, past_due FROM parties ORDER BY name');
        console.log('=== PARTIES BACKUP ===');
        console.log(JSON.stringify(parties.rows, null, 2));

        const outputDir = __dirname + '/../../';
        fs.writeFileSync(outputDir + 'party_names_contacts_backup.json', JSON.stringify(parties.rows, null, 2));
        console.log('Saved party_names_contacts_backup.json');

        // 2. Count all tables
        const tables = ['parties', 'mirchi_types', 'lots', 'transactions', 'transaction_items',
            'expenses', 'payments', 'party_jama_entries',
            'patti_lots', 'patti_transactions', 'patti_transaction_items',
            'patti_expenses', 'patti_payments'];

        console.log('\n=== TABLE COUNTS ===');
        for (const table of tables) {
            try {
                const count = await client.query(`SELECT COUNT(*) FROM ${table}`);
                console.log(`${table}: ${count.rows[0].count} rows`);
            } catch (e) {
                console.log(`${table}: ERROR - ${e.message}`);
            }
        }

        // 3. Full data dump
        const fullBackup = {};
        for (const table of tables) {
            try {
                const data = await client.query(`SELECT * FROM ${table}`);
                fullBackup[table] = data.rows;
            } catch (e) {
                fullBackup[table] = { error: e.message };
            }
        }
        fs.writeFileSync(outputDir + 'full_backup_2026-03-09.json', JSON.stringify(fullBackup, null, 2));
        console.log('\nSaved full_backup_2026-03-09.json');

    } catch (err) {
        console.error('Error:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

backup();
