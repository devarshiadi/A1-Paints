const pool = require('./config');

const createTables = async () => {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting database migration...');

        await client.query('BEGIN');

        // 1. Create parties table
        await client.query(`
      CREATE TABLE IF NOT EXISTS parties (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        city VARCHAR(100),
        party_type VARCHAR(20) NOT NULL CHECK (party_type IN ('awaak', 'jawaak', 'both')),
        current_balance DECIMAL(12, 2) DEFAULT 0,
        past_due DECIMAL(12, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        console.log('✅ Created table: parties');

        await client.query(`
      ALTER TABLE parties
      ADD COLUMN IF NOT EXISTS past_due DECIMAL(12, 2) DEFAULT 0
    `);

        // 2. Create mirchi_types table
        await client.query(`
      CREATE TABLE IF NOT EXISTS mirchi_types (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        unit VARCHAR(10) NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg', 'liter')),
        current_rate DECIMAL(10, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        console.log('✅ Created table: mirchi_types');

        // 3. Create lots table
        await client.query(`
      CREATE TABLE IF NOT EXISTS lots (
        id VARCHAR(50) PRIMARY KEY,
        lot_number VARCHAR(100) NOT NULL UNIQUE,
        mirchi_type_id VARCHAR(50) NOT NULL REFERENCES mirchi_types(id) ON DELETE CASCADE,
        mirchi_name VARCHAR(100) NOT NULL,
        unit VARCHAR(10) NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg', 'liter')),
        total_quantity DECIMAL(10, 2) NOT NULL,
        remaining_quantity DECIMAL(10, 2) NOT NULL,
        purchase_date DATE NOT NULL,
        status VARCHAR(20) NOT NULL CHECK (status IN ('active', 'sold_out')),
        avg_rate DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        console.log('✅ Created table: lots');

        // 4. Create transactions table
        await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(50) PRIMARY KEY,
        bill_number VARCHAR(100) NOT NULL UNIQUE,
        bill_date DATE NOT NULL,
        bill_type VARCHAR(20) NOT NULL CHECK (bill_type IN ('awaak', 'jawaak')),
        is_return BOOLEAN DEFAULT FALSE,
        party_id VARCHAR(50) NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        party_name VARCHAR(255),
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
        console.log('✅ Created table: transactions');

        // 5. Create transaction_items table
        await client.query(`
      CREATE TABLE IF NOT EXISTS transaction_items (
        id VARCHAR(50) PRIMARY KEY,
        transaction_id VARCHAR(50) NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        mirchi_type_id VARCHAR(50) NOT NULL REFERENCES mirchi_types(id),
        mirchi_name VARCHAR(100),
        unit VARCHAR(10) NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg', 'liter')),
        quality VARCHAR(50),
        lot_id VARCHAR(50) REFERENCES lots(id),
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
        console.log('✅ Created table: transaction_items');

        // 6. Create expenses table
        await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        transaction_id VARCHAR(50) NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        cess_percent DECIMAL(5, 2) DEFAULT 0,
        cess_amount DECIMAL(10, 2) DEFAULT 0,
        adat_percent DECIMAL(5, 2) DEFAULT 0,
        adat_amount DECIMAL(10, 2) DEFAULT 0,
        poti_rate DECIMAL(10, 2) DEFAULT 0,
        poti_amount DECIMAL(10, 2) DEFAULT 0,
        hamali_per_poti DECIMAL(10, 2) DEFAULT 0,
        hamali_amount DECIMAL(10, 2) DEFAULT 0,
        packaging_hamali_per_poti DECIMAL(10, 2) DEFAULT 0,
        packaging_hamali_amount DECIMAL(10, 2) DEFAULT 0,
        gaadi_bharni DECIMAL(10, 2) DEFAULT 0,
        other_expenses DECIMAL(10, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        // Ensure column exists on existing databases as well
        await client.query(`
      ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS other_expenses DECIMAL(10, 2) DEFAULT 0
    `);
        console.log('✅ Created table: expenses');

        // 7. Create payments table
        await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        transaction_id VARCHAR(50) NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        mode VARCHAR(20) NOT NULL CHECK (mode IN ('cash', 'online', 'cheque', 'due')),
        amount DECIMAL(12, 2) NOT NULL,
        reference VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        console.log('✅ Created table: payments');

        // Create indexes for better performance
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_party ON transactions(party_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(bill_date);
      CREATE INDEX IF NOT EXISTS idx_transaction_items_tx ON transaction_items(transaction_id);
      CREATE INDEX IF NOT EXISTS idx_lots_mirchi ON lots(mirchi_type_id);
      CREATE INDEX IF NOT EXISTS idx_lots_status ON lots(status);
    `);
        console.log('✅ Created indexes');

        await client.query('COMMIT');
        console.log('✅ Migration completed successfully!');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

createTables().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
