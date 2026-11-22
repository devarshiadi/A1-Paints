const pool = require('./config');

const migrate5 = async () => {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting database migration (migrate5)...');

        await client.query('BEGIN');

        await client.query(`
      CREATE TABLE IF NOT EXISTS patti_lots (
        id VARCHAR(50) PRIMARY KEY,
        lot_number VARCHAR(100) NOT NULL UNIQUE,
        mirchi_type_id VARCHAR(50) NOT NULL REFERENCES mirchi_types(id) ON DELETE CASCADE,
        mirchi_name VARCHAR(100) NOT NULL,
        total_quantity DECIMAL(10, 2) NOT NULL,
        remaining_quantity DECIMAL(10, 2) NOT NULL,
        owner_party_id VARCHAR(50) REFERENCES parties(id) ON DELETE SET NULL,
        purchase_date DATE NOT NULL,
        status VARCHAR(20) NOT NULL CHECK (status IN ('active', 'sold_out')),
        avg_rate DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS patti_transactions (
        id VARCHAR(50) PRIMARY KEY,
        bill_number VARCHAR(100) NOT NULL,
        bill_date DATE NOT NULL,
        bill_type VARCHAR(30) NOT NULL CHECK (bill_type IN ('patti_awaak', 'patti_jawaak')),
        is_return BOOLEAN DEFAULT FALSE,
        party_id VARCHAR(50) NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        party_name VARCHAR(255),
        invoice_group_id VARCHAR(80),
        gross_weight_total DECIMAL(10, 2) DEFAULT 0,
        net_weight_total DECIMAL(10, 2) DEFAULT 0,
        subtotal DECIMAL(12, 2) DEFAULT 0,
        total_expenses DECIMAL(12, 2) DEFAULT 0,
        total_amount DECIMAL(12, 2) NOT NULL,
        paid_amount DECIMAL(12, 2) DEFAULT 0,
        balance_amount DECIMAL(12, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        await client.query(`
      ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS invoice_group_id VARCHAR(80)
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS patti_transaction_items (
        id VARCHAR(50) PRIMARY KEY,
        transaction_id VARCHAR(50) NOT NULL REFERENCES patti_transactions(id) ON DELETE CASCADE,
        mirchi_type_id VARCHAR(50) NOT NULL REFERENCES mirchi_types(id),
        mirchi_name VARCHAR(100),
        quality VARCHAR(50),
        lot_id VARCHAR(50) REFERENCES patti_lots(id),
        lot_number VARCHAR(100),
        poti_weights TEXT,
        gross_weight DECIMAL(10, 2) NOT NULL,
        poti_count INTEGER NOT NULL,
        total_potya DECIMAL(10, 2) DEFAULT 0,
        net_weight DECIMAL(10, 2) NOT NULL,
        rate_per_kg DECIMAL(10, 2) NOT NULL,
        item_total DECIMAL(12, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS patti_expenses (
        id SERIAL PRIMARY KEY,
        transaction_id VARCHAR(50) NOT NULL REFERENCES patti_transactions(id) ON DELETE CASCADE,
        packing DECIMAL(10, 2) DEFAULT 0,
        godown DECIMAL(10, 2) DEFAULT 0,
        hamali DECIMAL(10, 2) DEFAULT 0,
        commission DECIMAL(10, 2) DEFAULT 0,
        gaadi_bhade DECIMAL(10, 2) DEFAULT 0,
        advance DECIMAL(10, 2) DEFAULT 0,
        other_expenses DECIMAL(10, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS patti_payments (
        id SERIAL PRIMARY KEY,
        transaction_id VARCHAR(50) NOT NULL REFERENCES patti_transactions(id) ON DELETE CASCADE,
        mode VARCHAR(20) NOT NULL CHECK (mode IN ('cash', 'online', 'cheque', 'due')),
        amount DECIMAL(12, 2) NOT NULL,
        reference VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_patti_transactions_party ON patti_transactions(party_id);
      CREATE INDEX IF NOT EXISTS idx_patti_transactions_date ON patti_transactions(bill_date);
      CREATE INDEX IF NOT EXISTS idx_patti_transaction_items_tx ON patti_transaction_items(transaction_id);
      CREATE INDEX IF NOT EXISTS idx_patti_lots_mirchi ON patti_lots(mirchi_type_id);
      CREATE INDEX IF NOT EXISTS idx_patti_lots_status ON patti_lots(status);
    `);

        await client.query('COMMIT');
        console.log('✅ migrate5 completed successfully!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ migrate5 failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

migrate5().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
