const pool = require('./config');
const { v4: uuidv4 } = require('uuid');

const seedData = async () => {
    const client = await pool.connect();

    try {
        console.log('🌱 Starting database seeding...');

        await client.query('BEGIN');

        // 1. Seed Parties
        const parties = [
            { id: 'p1', name: 'Ramesh Traders', phone: '9876543210', city: 'Byadgi', party_type: 'both', current_balance: 0 },
            { id: 'p2', name: 'Suresh & Co', phone: '9876543211', city: 'Guntur', party_type: 'jawaak', current_balance: 0 },
            { id: 'p3', name: 'Kisan Vyapar', phone: '9876543212', city: 'Nagpur', party_type: 'awaak', current_balance: 0 },
            { id: 'p4', name: 'Mahesh Enterprises', phone: '9876543213', city: 'Mumbai', party_type: 'both', current_balance: 0 },
            { id: 'p5', name: 'Ganesh Trading Co', phone: '9876543214', city: 'Pune', party_type: 'jawaak', current_balance: 0 }
        ];

        for (const party of parties) {
            await client.query(
                `INSERT INTO parties (id, name, phone, city, party_type, current_balance) 
         VALUES ($1, $2, $3, $4, $5, $6) 
         ON CONFLICT (id) DO NOTHING`,
                [party.id, party.name, party.phone, party.city, party.party_type, party.current_balance]
            );
        }
        console.log(`✅ Seeded ${parties.length} parties`);

        // 2. Seed Mirchi Types
        const mirchiTypes = [
            { id: 'm1', name: 'Teja', current_rate: 180 },
            { id: 'm2', name: 'Byadgi', current_rate: 220 },
            { id: 'm3', name: 'Guntur Sannam', current_rate: 150 },
            { id: 'm4', name: 'Kashmiri', current_rate: 300 },
            { id: 'm5', name: 'Reshampatti', current_rate: 250 }
        ];

        for (const type of mirchiTypes) {
            await client.query(
                `INSERT INTO mirchi_types (id, name, current_rate) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (name) DO NOTHING`,
                [type.id, type.name, type.current_rate]
            );
        }
        console.log(`✅ Seeded ${mirchiTypes.length} mirchi types`);

        // 3. Seed Lots
        const lots = [
            {
                id: 'l1',
                lot_number: 'LOT-TEJ-20241120-001',
                mirchi_type_id: 'm1',
                mirchi_name: 'Teja',
                total_quantity: 500,
                remaining_quantity: 200,
                purchase_date: '2024-11-20',
                status: 'active',
                avg_rate: 175
            },
            {
                id: 'l2',
                lot_number: 'LOT-BYA-20241121-002',
                mirchi_type_id: 'm2',
                mirchi_name: 'Byadgi',
                total_quantity: 1000,
                remaining_quantity: 850,
                purchase_date: '2024-11-21',
                status: 'active',
                avg_rate: 210
            },
            {
                id: 'l3',
                lot_number: 'LOT-GUN-20241122-003',
                mirchi_type_id: 'm3',
                mirchi_name: 'Guntur Sannam',
                total_quantity: 750,
                remaining_quantity: 600,
                purchase_date: '2024-11-22',
                status: 'active',
                avg_rate: 145
            }
        ];

        for (const lot of lots) {
            await client.query(
                `INSERT INTO lots (id, lot_number, mirchi_type_id, mirchi_name, total_quantity, remaining_quantity, purchase_date, status, avg_rate) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
         ON CONFLICT (lot_number) DO NOTHING`,
                [lot.id, lot.lot_number, lot.mirchi_type_id, lot.mirchi_name, lot.total_quantity, lot.remaining_quantity, lot.purchase_date, lot.status, lot.avg_rate]
            );
        }
        console.log(`✅ Seeded ${lots.length} lots`);

        // 4. Seed Sample Transactions
        const tx1Id = 'tx1';
        await client.query(
            `INSERT INTO transactions (id, bill_number, bill_date, bill_type, is_return, party_id, party_name, gross_weight_total, net_weight_total, subtotal, total_expenses, total_amount, paid_amount, balance_amount) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) 
       ON CONFLICT (bill_number) DO NOTHING`,
            [tx1Id, 'JAWAAK-2024-0001', '2024-11-20', 'jawaak', false, 'p3', 'Kisan Vyapar', 500, 500, 87500, 4375, 91875, 50000, 41875]
        );

        await client.query(
            `INSERT INTO transaction_items (id, transaction_id, mirchi_type_id, mirchi_name, quality, lot_id, poti_weights, gross_weight, poti_count, total_potya, net_weight, rate_per_kg, item_total) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) 
       ON CONFLICT (id) DO NOTHING`,
            ['tx1-item1', tx1Id, 'm1', 'Teja', 'A+', 'l1', '[100,100,100,100,100]', 500, 5, 0, 500, 175, 87500]
        );

        await client.query(
            `INSERT INTO expenses (transaction_id, cess_percent, cess_amount, adat_percent, adat_amount, hamali_per_poti, hamali_amount) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [tx1Id, 2.0, 1750, 3.0, 2625, 0, 0]
        );

        await client.query(
            `INSERT INTO payments (transaction_id, mode, amount, reference) 
       VALUES ($1, $2, $3, $4)`,
            [tx1Id, 'cash', 50000, 'Initial payment']
        );

        console.log('✅ Seeded sample transaction');

        await client.query('COMMIT');
        console.log('✅ Seeding completed successfully!');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Seeding failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

seedData().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
