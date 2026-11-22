const express = require('express');
const router = express.Router();
const pool = require('../db/config');

/**
 * GET /api/dashboard/summary?low_stock_threshold=10
 *
 * Single consolidated endpoint that computes all dashboard KPIs server-side
 * using SQL aggregates. Replaces the old pattern where the frontend fetched
 * every transaction, lot and party and reduced them in the browser.
 *
 * Covers: Total Stock, Bags Sold Today, Est. Value, Receivables, Payables,
 * Recent Transactions, Pending Payments, Low-stock lots, Stock-by-mirchi chart.
 */
router.get('/summary', async (req, res) => {
    try {
        const lowStockThreshold = Math.max(0, parseInt(req.query.low_stock_threshold, 10) || 10);
        const recentLimit = Math.min(50, Math.max(1, parseInt(req.query.recent_limit, 10) || 5));
        // Use Asia/Kolkata calendar day — Node's process clock is UTC on the
        // production host, so `new Date()` was lagging IST by 5h30m and hiding
        // bills entered late at night from the "today" KPI.
        const todayRes = await pool.query(
            "SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today"
        );
        const today = todayRes.rows[0].today;

        const [
            stockRes,
            bagsSoldTodayRes,
            estValueRes,
            balancesRes,
            recentRes,
            lowStockRes,
            stockByMirchiRes,
            duePartiesRes,
        ] = await Promise.all([
            // 1. Total active stock (bags) — regular + patti, negative remainders clamped to 0
            pool.query(`
                SELECT
                    COALESCE((SELECT SUM(GREATEST(remaining_quantity, 0)) FROM lots WHERE status = 'active'), 0)
                    +
                    COALESCE((SELECT SUM(GREATEST(remaining_quantity, 0)) FROM patti_lots WHERE status = 'active'), 0)
                    AS total_stock_bags
            `),

            // 2. Quantity sold today (jawaak + patti_jawaak, net of returns)
            pool.query(`
                SELECT
                    COALESCE((
                        SELECT SUM(CASE WHEN t.is_return THEN -ti.net_weight ELSE ti.net_weight END)
                        FROM transactions t
                        JOIN transaction_items ti ON t.id = ti.transaction_id
                        WHERE t.bill_type = 'jawaak' AND t.bill_date = $1::date
                    ), 0)
                    +
                    COALESCE((
                        SELECT SUM(CASE WHEN t.is_return THEN -ti.net_weight ELSE ti.net_weight END)
                        FROM patti_transactions t
                        JOIN patti_transaction_items ti ON t.id = ti.transaction_id
                        WHERE t.bill_type = 'patti_jawaak' AND t.bill_date = $1::date
                    ), 0)
                    AS bags_sold_today
            `, [today]),

            // 3. Estimated stock value, using the configured inventory quantity unit.
            pool.query(`
                WITH reg_sales AS (
                    SELECT ti.lot_id, SUM(ti.net_weight) AS kg, SUM(ti.poti_count) AS bags
                    FROM transaction_items ti
                    JOIN transactions t ON t.id = ti.transaction_id
                    WHERE t.bill_type = 'jawaak'
                      AND NOT COALESCE(t.is_return, false)
                      AND ti.lot_id IS NOT NULL
                    GROUP BY ti.lot_id
                ),
                patti_sales AS (
                    SELECT ti.lot_id, SUM(ti.net_weight) AS kg, SUM(ti.poti_count) AS bags
                    FROM patti_transaction_items ti
                    JOIN patti_transactions t ON t.id = ti.transaction_id
                    WHERE t.bill_type = 'patti_jawaak'
                      AND NOT COALESCE(t.is_return, false)
                      AND ti.lot_id IS NOT NULL
                    GROUP BY ti.lot_id
                ),
                reg_value AS (
                    SELECT COALESCE(SUM(
                        GREATEST(l.remaining_quantity, 0) * l.avg_rate
                    ), 0) AS v
                    FROM lots l
                    LEFT JOIN reg_sales rs ON rs.lot_id = l.id
                    WHERE l.status = 'active'
                ),
                patti_value AS (
                    SELECT COALESCE(SUM(
                        GREATEST(pl.remaining_quantity, 0)
                        * (CASE WHEN ps.bags > 0 THEN ps.kg / ps.bags ELSE 0 END)
                        * pl.avg_rate
                    ), 0) AS v
                    FROM patti_lots pl
                    LEFT JOIN patti_sales ps ON ps.lot_id = pl.id
                    WHERE pl.status = 'active'
                )
                SELECT (reg_value.v + patti_value.v) AS est_value FROM reg_value, patti_value
            `),

            // 4. Receivables / payables / due party count (includes past_due as well as current_balance)
            pool.query(`
                SELECT
                    COALESCE(SUM(CASE
                        WHEN (COALESCE(current_balance, 0) + COALESCE(past_due, 0)) > 0
                        THEN (COALESCE(current_balance, 0) + COALESCE(past_due, 0))
                        ELSE 0
                    END), 0) AS receivables,
                    COALESCE(SUM(CASE
                        WHEN (COALESCE(current_balance, 0) + COALESCE(past_due, 0)) < 0
                        THEN (COALESCE(current_balance, 0) + COALESCE(past_due, 0))
                        ELSE 0
                    END), 0) AS payables_signed,
                    COUNT(*) FILTER (
                        WHERE (COALESCE(current_balance, 0) + COALESCE(past_due, 0)) <> 0
                    ) AS due_party_count
                FROM parties
            `),

            // 5. Recent transactions — merged top N from regular + patti
            pool.query(`
                SELECT * FROM (
                    (SELECT id, bill_number, bill_date, bill_type,
                            COALESCE(is_return, false) AS is_return,
                            party_id, party_name, total_amount, created_at,
                            'regular' AS source
                       FROM transactions
                       ORDER BY created_at DESC NULLS LAST, bill_date DESC
                       LIMIT $1)
                    UNION ALL
                    (SELECT id, bill_number, bill_date, bill_type,
                            COALESCE(is_return, false) AS is_return,
                            party_id, party_name, total_amount, created_at,
                            'patti' AS source
                       FROM patti_transactions
                       ORDER BY created_at DESC NULLS LAST, bill_date DESC
                       LIMIT $1)
                ) merged
                ORDER BY created_at DESC NULLS LAST, bill_date DESC
                LIMIT $1
            `, [recentLimit]),

            // 6. Low-stock active lots (threshold in bags)
            pool.query(`
                SELECT * FROM (
                    (SELECT id, lot_number, mirchi_name,
                            remaining_quantity AS bags,
                            'regular' AS source
                       FROM lots
                       WHERE status = 'active'
                         AND remaining_quantity > 0
                         AND remaining_quantity <= $1)
                    UNION ALL
                    (SELECT id, lot_number, mirchi_name,
                            remaining_quantity AS bags,
                            'patti' AS source
                       FROM patti_lots
                       WHERE status = 'active'
                         AND remaining_quantity > 0
                         AND remaining_quantity <= $1)
                ) low
                ORDER BY bags ASC
                LIMIT 20
            `, [lowStockThreshold]),

            // 7. Stock distribution by mirchi name (drives the bar chart)
            pool.query(`
                SELECT mirchi_name, SUM(GREATEST(remaining_quantity, 0)) AS bags
                FROM (
                    SELECT mirchi_name, remaining_quantity
                      FROM lots WHERE status = 'active'
                    UNION ALL
                    SELECT mirchi_name, remaining_quantity
                      FROM patti_lots WHERE status = 'active'
                ) combined
                GROUP BY mirchi_name
                HAVING SUM(GREATEST(remaining_quantity, 0)) > 0
                ORDER BY bags DESC
            `),

            // 8. Due parties list (for the Pending Payments panel) — up to 50 highest-balance
            pool.query(`
                SELECT id, name, city, current_balance, past_due
                FROM parties
                WHERE (COALESCE(current_balance, 0) + COALESCE(past_due, 0)) <> 0
                ORDER BY ABS(COALESCE(current_balance, 0) + COALESCE(past_due, 0)) DESC
                LIMIT 50
            `),
        ]);

        res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
        res.json({
            success: true,
            data: {
                total_stock_bags: Number(stockRes.rows[0].total_stock_bags) || 0,
                bags_sold_today: Number(bagsSoldTodayRes.rows[0].bags_sold_today) || 0,
                est_value: Number(estValueRes.rows[0].est_value) || 0,
                receivables: Number(balancesRes.rows[0].receivables) || 0,
                payables: Math.abs(Number(balancesRes.rows[0].payables_signed) || 0),
                due_party_count: Number(balancesRes.rows[0].due_party_count) || 0,
                recent_transactions: recentRes.rows.map((r) => ({
                    id: r.id,
                    bill_number: r.bill_number,
                    bill_date: r.bill_date,
                    bill_type: r.bill_type,
                    is_return: Boolean(r.is_return),
                    party_id: r.party_id,
                    party_name: r.party_name,
                    total_amount: Number(r.total_amount) || 0,
                    created_at: r.created_at,
                    source: r.source,
                })),
                low_stock_lots: lowStockRes.rows.map((r) => ({
                    id: r.id,
                    lot_number: r.lot_number,
                    mirchi_name: r.mirchi_name,
                    bags: Number(r.bags) || 0,
                    source: r.source,
                })),
                stock_by_mirchi: stockByMirchiRes.rows.map((r) => ({
                    name: r.mirchi_name,
                    bags: Number(r.bags) || 0,
                })),
                due_parties: duePartiesRes.rows.map((r) => ({
                    id: r.id,
                    name: r.name,
                    city: r.city,
                    current_balance: Number(r.current_balance) || 0,
                    past_due: Number(r.past_due) || 0,
                })),
                today,
                low_stock_threshold: lowStockThreshold,
            },
        });
    } catch (error) {
        console.error('Error building dashboard summary:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/dashboard/patti-summary
 *
 * Dedicated Patti analytics endpoint. The main /summary blends regular + patti;
 * this one is patti-only so the Dashboard can render a distinct Patti section
 * with its own chart, KPIs, and top-lots list.
 *
 * Returns:
 *  - patti_total_stock_bags, patti_bags_sold_today, patti_est_value
 *  - patti_receivables, patti_payables (patti_transactions side only)
 *  - patti_commission_total (all-time commission earned)
 *  - patti_bags_sold_this_month
 *  - patti_stock_by_mirchi   (chart data)
 *  - patti_top_lots          (top N active lots by remaining bags)
 *  - patti_top_commission_parties (top N owner parties by commission earned)
 */
router.get('/patti-summary', async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const topLotsLimit = Math.min(20, Math.max(1, parseInt(req.query.top_lots_limit, 10) || 5));

        const [
            stockRes,
            soldTodayRes,
            estValueRes,
            balancesRes,
            commissionRes,
            monthSalesRes,
            stockByMirchiRes,
            topLotsRes,
            topPartiesRes,
        ] = await Promise.all([
            // 1. Total active patti stock (bags), negative clamped
            pool.query(`
                SELECT COALESCE(SUM(GREATEST(remaining_quantity, 0)), 0) AS bags
                FROM patti_lots
                WHERE status = 'active'
            `),

            // 2. Patti bags sold today (net of returns)
            pool.query(`
                SELECT COALESCE(SUM(
                    CASE WHEN t.is_return THEN -ti.poti_count ELSE ti.poti_count END
                ), 0) AS bags
                FROM patti_transactions t
                JOIN patti_transaction_items ti ON t.id = ti.transaction_id
                WHERE t.bill_type = 'patti_jawaak' AND t.bill_date = $1::date
            `, [today]),

            // 3. Patti est. value — kg/bag derived from patti sales, applied to remaining × avg_rate
            pool.query(`
                WITH patti_sales AS (
                    SELECT ti.lot_id,
                           SUM(ti.net_weight) AS kg,
                           SUM(ti.poti_count) AS bags
                    FROM patti_transaction_items ti
                    JOIN patti_transactions t ON t.id = ti.transaction_id
                    WHERE t.bill_type = 'patti_jawaak'
                      AND NOT COALESCE(t.is_return, false)
                      AND ti.lot_id IS NOT NULL
                    GROUP BY ti.lot_id
                )
                SELECT COALESCE(SUM(
                    GREATEST(pl.remaining_quantity, 0)
                    * (CASE WHEN ps.bags > 0 THEN ps.kg / ps.bags ELSE 0 END)
                    * pl.avg_rate
                ), 0) AS est_value
                FROM patti_lots pl
                LEFT JOIN patti_sales ps ON ps.lot_id = pl.id
                WHERE pl.status = 'active'
            `),

            // 4. Patti-side receivables & payables (from patti_transactions only)
            pool.query(`
                SELECT
                    COALESCE(SUM(CASE
                        WHEN pt.bill_type = 'patti_jawaak' AND NOT COALESCE(pt.is_return, false)
                            THEN COALESCE(pt.balance_amount, 0)
                        WHEN pt.bill_type = 'patti_jawaak' AND COALESCE(pt.is_return, false)
                            THEN -COALESCE(pt.balance_amount, 0)
                        ELSE 0
                    END), 0) AS receivables,
                    COALESCE(SUM(CASE
                        WHEN pt.bill_type = 'patti_awaak' AND NOT COALESCE(pt.is_return, false)
                            THEN COALESCE(pt.balance_amount, 0)
                        WHEN pt.bill_type = 'patti_awaak' AND COALESCE(pt.is_return, false)
                            THEN -COALESCE(pt.balance_amount, 0)
                        ELSE 0
                    END), 0) AS payables
                FROM patti_transactions pt
            `),

            // 5. All-time commission earned (patti_expenses.commission)
            pool.query(`
                SELECT COALESCE(SUM(commission), 0) AS total_commission
                FROM patti_expenses
            `),

            // 6. Patti bags sold this calendar month (net of returns)
            pool.query(`
                SELECT COALESCE(SUM(
                    CASE WHEN t.is_return THEN -ti.poti_count ELSE ti.poti_count END
                ), 0) AS bags
                FROM patti_transactions t
                JOIN patti_transaction_items ti ON t.id = ti.transaction_id
                WHERE t.bill_type = 'patti_jawaak'
                  AND t.bill_date >= date_trunc('month', CURRENT_DATE)::date
            `),

            // 7. Stock by mirchi — chart data for the Patti bar chart
            pool.query(`
                SELECT mirchi_name,
                       SUM(GREATEST(remaining_quantity, 0)) AS bags
                FROM patti_lots
                WHERE status = 'active'
                GROUP BY mirchi_name
                HAVING SUM(GREATEST(remaining_quantity, 0)) > 0
                ORDER BY bags DESC
            `),

            // 8. Top active patti lots by remaining bags
            pool.query(`
                SELECT pl.id,
                       pl.lot_number,
                       pl.mirchi_name,
                       GREATEST(pl.remaining_quantity, 0) AS bags,
                       pl.owner_party_id,
                       p.name AS owner_party_name
                FROM patti_lots pl
                LEFT JOIN parties p ON p.id = pl.owner_party_id
                WHERE pl.status = 'active' AND pl.remaining_quantity > 0
                ORDER BY pl.remaining_quantity DESC
                LIMIT $1
            `, [topLotsLimit]),

            // 9. Top N owner parties by commission earned (joins patti_expenses → patti_transactions)
            pool.query(`
                SELECT p.id, p.name,
                       COALESCE(SUM(pe.commission), 0) AS commission_total,
                       COUNT(DISTINCT pt.id) AS bill_count
                FROM patti_transactions pt
                JOIN patti_expenses pe ON pe.transaction_id = pt.id
                LEFT JOIN parties p ON p.id = pt.party_id
                WHERE pe.commission IS NOT NULL AND pe.commission > 0
                GROUP BY p.id, p.name
                ORDER BY commission_total DESC
                LIMIT 10
            `),
        ]);

        res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
        res.json({
            success: true,
            data: {
                patti_total_stock_bags: Number(stockRes.rows[0].bags) || 0,
                patti_bags_sold_today: Number(soldTodayRes.rows[0].bags) || 0,
                patti_est_value: Number(estValueRes.rows[0].est_value) || 0,
                patti_receivables: Number(balancesRes.rows[0].receivables) || 0,
                patti_payables: Number(balancesRes.rows[0].payables) || 0,
                patti_commission_total: Number(commissionRes.rows[0].total_commission) || 0,
                patti_bags_sold_this_month: Number(monthSalesRes.rows[0].bags) || 0,
                patti_stock_by_mirchi: stockByMirchiRes.rows.map((r) => ({
                    name: r.mirchi_name,
                    bags: Number(r.bags) || 0,
                })),
                patti_top_lots: topLotsRes.rows.map((r) => ({
                    id: r.id,
                    lot_number: r.lot_number,
                    mirchi_name: r.mirchi_name,
                    bags: Number(r.bags) || 0,
                    owner_party_id: r.owner_party_id,
                    owner_party_name: r.owner_party_name || null,
                })),
                patti_top_commission_parties: topPartiesRes.rows.map((r) => ({
                    id: r.id,
                    name: r.name,
                    commission_total: Number(r.commission_total) || 0,
                    bill_count: Number(r.bill_count) || 0,
                })),
                today,
            },
        });
    } catch (error) {
        console.error('Error building patti summary:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
