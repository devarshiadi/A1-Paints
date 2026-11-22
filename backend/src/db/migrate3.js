const pool = require('./config');

const migrate3 = async () => {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting database migration (migrate3)...');

        await client.query('BEGIN');

        // Standalone Jama entries (overall party receipts) - not linked to bills
        await client.query(`
      CREATE TABLE IF NOT EXISTS party_jama_entries (
        id VARCHAR(50) PRIMARY KEY,
        party_id VARCHAR(50) NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        amount DECIMAL(12, 2) NOT NULL,
        note VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_party_jama_entries_party_id
      ON party_jama_entries(party_id)
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_party_jama_entries_entry_date
      ON party_jama_entries(entry_date)
    `);

        await client.query('COMMIT');
        console.log('✅ migrate3 completed successfully!');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ migrate3 failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

migrate3().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
