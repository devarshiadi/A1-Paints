/**
 * Regression test for the invoice Magil Baki bug.
 *   node src/db/test_magil_baki.js
 *
 * The bug: downloading the invoice straight after saving showed
 * "मागील बाकी ₹0.00", while downloading the same bill later from the Party
 * Ledger showed the real ₹78,339.00. Same bill, same customer, same day, two
 * different numbers in a customer's hands.
 *
 * Cause: the create-bill response did not select party_past_due /
 * party_balance_before_bill, so the invoice component fell back to 0.
 *
 * This test asserts the three read paths agree. READ ONLY — no writes.
 */
const assert = require('assert');
const pool = require('./config');
const { COMPLETE_TRANSACTION_SQL } = require('../routes/transactions');
const { loadRegular, BALANCE_BEFORE_BILL_SQL } = require('../routes/pdf');

// The bill from the screenshots.
const BILL = 'J-B398';
const EXPECTED_MAGIL_BAKI = 78339;
const EXPECTED_TOTAL_BAKI = 89134;

// Mirrors PdfInvoice.tsx / PrintInvoice.tsx exactly.
const invoiceBaki = (tx) => {
    const hasBefore = tx.party_balance_before_bill !== undefined && tx.party_balance_before_bill !== null;
    const magil = hasBefore
        ? Number(tx.party_past_due || 0) + Number(tx.party_balance_before_bill || 0)
        : Number(tx.party_past_due || 0);
    const change = tx.is_return ? -Number(tx.balance_amount || 0) : Number(tx.balance_amount || 0);
    return { hasBefore, magil, total: magil + change };
};

(async () => {
    const { rows } = await pool.query('SELECT id FROM transactions WHERE bill_number = $1', [BILL]);
    assert.strictEqual(rows.length, 1, `expected exactly one bill ${BILL}, found ${rows.length}`);
    const id = rows[0].id;

    // 1. What the SAVE screen prints (the path that used to show ₹0.00).
    const onSave = (await pool.query(COMPLETE_TRANSACTION_SQL, [id])).rows[0];

    // 2. What the PARTY LEDGER / PDF prints (the path that was always right).
    const onReprint = await loadRegular(id);

    // 3. The list endpoint, which the ledger screen reads.
    const inList = (await pool.query(
        `SELECT t.*, pa.past_due AS party_past_due,
                (${BALANCE_BEFORE_BILL_SQL}) AS party_balance_before_bill
           FROM transactions t LEFT JOIN parties pa ON pa.id = t.party_id
          WHERE t.id = $1`, [id])).rows[0];

    const save = invoiceBaki(onSave);
    const reprint = invoiceBaki(onReprint);
    const list = invoiceBaki(inList);

    // The actual regression: the save path must KNOW the balance.
    assert.ok(save.hasBefore, 'create-bill response is missing party_balance_before_bill — invoice would print ₹0.00');

    // All three paths must agree, or the customer can be handed two versions.
    assert.strictEqual(save.magil, reprint.magil, `save ${save.magil} != reprint ${reprint.magil}`);
    assert.strictEqual(save.magil, list.magil, `save ${save.magil} != ledger list ${list.magil}`);
    assert.strictEqual(save.total, reprint.total, 'Total Baki differs between save and reprint');

    // And they must equal the figure the customer was eventually shown.
    assert.strictEqual(save.magil, EXPECTED_MAGIL_BAKI, `Magil Baki ${save.magil}, expected ${EXPECTED_MAGIL_BAKI}`);
    assert.strictEqual(save.total, EXPECTED_TOTAL_BAKI, `Total Baki ${save.total}, expected ${EXPECTED_TOTAL_BAKI}`);

    console.log(`✅ ${BILL}: Magil Baki ₹${save.magil} / Total Baki ₹${save.total} — save, reprint and ledger all agree`);

    // A MIXED invoice is two rows sharing one invoice_group_id. Neither half may
    // count the other as "earlier", or the pair disagrees about the same invoice.
    const groups = await pool.query(`
        SELECT t.invoice_group_id,
               COUNT(*)                                        AS halves,
               COUNT(DISTINCT (${BALANCE_BEFORE_BILL_SQL}))    AS distinct_balances
          FROM transactions t
         WHERE t.invoice_group_id IS NOT NULL
         GROUP BY t.invoice_group_id`);
    for (const g of groups.rows) {
        assert.strictEqual(
            Number(g.distinct_balances), 1,
            `invoice group ${g.invoice_group_id}: its ${g.halves} halves report different Magil Baki`
        );
    }
    console.log(`✅ ${groups.rows.length} grouped invoice(s): every half reports the same pre-invoice balance`);

    await pool.end();
})();
