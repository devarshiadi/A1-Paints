const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const pool = require('../db/config');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansDevanagari.ttf');

// Sanity check — fail loudly at server start if the font is missing.
if (!fs.existsSync(FONT_PATH)) {
    console.warn(`[pdf] Devanagari font missing at ${FONT_PATH} — PDF invoices will fall back to Helvetica.`);
}

// ========= helpers =========
const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

const formatINR = (v) => {
    const n = toNum(v);
    return `₹${n.toFixed(2)}`;
};

const formatDate = (d) => {
    if (!d) return '-';
    const date = new Date(d);
    if (Number.isNaN(date.getTime())) return String(d);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
};

// ========= DB loaders =========
// Subquery that computes the party's running balance just BEFORE this bill —
// matches what the Ledger PDF's YENE column shows on the line above this bill.
// Magil Baki on the printed invoice = party_past_due + party_balance_before_bill.
//
// Walks every prior event chronologically:
//   + balance_amount of every earlier regular bill
//   + balance_amount of every earlier patti bill
//   − amount     of every earlier jama payment
// Return bills flip sign on balance_amount (a return REDUCES outstanding).
// Requires `t` (the transaction) to be the outer table alias.
//
// A MIXED bill is saved as a regular + a patti row sharing one invoice_group_id,
// written concurrently. Without the group exclusion below, whichever row commits
// second counts the first as "earlier" and its Magil Baki comes out inflated by
// its own twin — and which one that is changes run to run. Both halves of one
// printed invoice must report the outstanding from BEFORE the whole invoice.
//
// IS DISTINCT FROM, not `=`: an earlier bill with a NULL invoice_group_id made
// `NOT (TRUE AND NULL)` evaluate to NULL, which silently dropped that bill while
// every jama payment stayed in — Magil Baki printed hugely negative (J-C55).
const BALANCE_BEFORE_BILL_SQL = `
    COALESCE((
        SELECT SUM(CASE WHEN tt.is_return THEN -tt.balance_amount ELSE tt.balance_amount END)
          FROM transactions tt
         WHERE tt.party_id = t.party_id AND tt.created_at < t.created_at
           AND (t.invoice_group_id IS NULL OR tt.invoice_group_id IS DISTINCT FROM t.invoice_group_id)
    ), 0)
    + COALESCE((
        SELECT SUM(CASE WHEN pt.is_return THEN -pt.balance_amount ELSE pt.balance_amount END)
          FROM patti_transactions pt
         WHERE pt.party_id = t.party_id AND pt.created_at < t.created_at
           AND (t.invoice_group_id IS NULL OR pt.invoice_group_id IS DISTINCT FROM t.invoice_group_id)
    ), 0)
    - COALESCE((
        SELECT SUM(j.amount)
          FROM party_jama_entries j
         WHERE j.party_id = t.party_id AND j.created_at < t.created_at
    ), 0)
`;

const loadRegular = async (id) => {
    const { rows } = await pool.query(
        `
        SELECT t.*,
               pa.phone           AS party_phone,
               pa.past_due        AS party_past_due,
               pa.current_balance AS party_current_balance,
               (${BALANCE_BEFORE_BILL_SQL}) AS party_balance_before_bill,
               COALESCE((
                   SELECT json_agg(jsonb_build_object(
                       'id', ti.id,
                       'product_name', ti.mirchi_name,
                     'mirchi_name', ti.mirchi_name,
                       'quality', ti.quality,
                     'unit', ti.unit,
                       'lot_id', ti.lot_id,
                       'lot_number', l.lot_number,
                       'poti_weights', ti.poti_weights,
                       'gross_weight', ti.gross_weight,
                       'poti_count', ti.poti_count,
                       'net_weight', ti.net_weight,
                       'rate_per_kg', ti.rate_per_kg,
                       'item_total', ti.item_total
                   ))
                   FROM transaction_items ti
                   LEFT JOIN lots l ON ti.lot_id = l.id
                   WHERE ti.transaction_id = t.id
               ), '[]'::json) AS items,
               COALESCE((
                   SELECT json_build_object(
                       'cess_amount', e.cess_amount,
                       'adat_amount', e.adat_amount,
                       'poti_amount', e.poti_amount,
                       'hamali_amount', e.hamali_amount,
                       'packaging_hamali_amount', e.packaging_hamali_amount,
                       'gaadi_bharni', e.gaadi_bharni,
                       'gaadi_number', e.gaadi_number,
                       'other_expenses', e.other_expenses
                   )
                   FROM expenses e
                   WHERE e.transaction_id = t.id
                   ORDER BY e.created_at DESC NULLS LAST, e.id DESC
                   LIMIT 1
               ), '{}'::json) AS expenses,
               COALESCE((
                   SELECT json_agg(jsonb_build_object(
                       'mode', p.mode, 'amount', p.amount, 'reference', p.reference
                   ))
                   FROM payments p
                   WHERE p.transaction_id = t.id
               ), '[]'::json) AS payments
          FROM transactions t
          LEFT JOIN parties pa ON pa.id = t.party_id
         WHERE t.id = $1
        `,
        [id]
    );
    return rows[0];
};

const loadPatti = async (id) => {
    const { rows } = await pool.query(
        `
        SELECT t.*,
               pa.phone           AS party_phone,
               pa.past_due        AS party_past_due,
               pa.current_balance AS party_current_balance,
               (${BALANCE_BEFORE_BILL_SQL}) AS party_balance_before_bill,
               COALESCE((
                   SELECT json_agg(jsonb_build_object(
                       'id', ti.id,
                       'product_name', ti.mirchi_name,
                     'mirchi_name', ti.mirchi_name,
                       'quality', ti.quality,
                     'unit', ti.unit,
                       'lot_id', ti.lot_id,
                       'lot_number', ti.lot_number,
                       'poti_weights', ti.poti_weights,
                       'gross_weight', ti.gross_weight,
                       'poti_count', ti.poti_count,
                       'net_weight', ti.net_weight,
                       'rate_per_kg', ti.rate_per_kg,
                       'item_total', ti.item_total
                   ))
                   FROM patti_transaction_items ti
                   WHERE ti.transaction_id = t.id
               ), '[]'::json) AS items,
               COALESCE((
                   SELECT json_build_object(
                       'packing', e.packing,
                       'godown', e.godown,
                       'hamali', e.hamali,
                       'commission', e.commission,
                       'gaadi_bhade', e.gaadi_bhade,
                       'gaadi_number', e.gaadi_number,
                       'advance', e.advance,
                       'other_expenses', e.other_expenses
                   )
                   FROM patti_expenses e
                   WHERE e.transaction_id = t.id
                   ORDER BY e.created_at DESC NULLS LAST, e.id DESC
                   LIMIT 1
               ), '{}'::json) AS expenses,
               COALESCE((
                   SELECT json_agg(jsonb_build_object(
                       'mode', p.mode, 'amount', p.amount, 'reference', p.reference
                   ))
                   FROM patti_payments p
                   WHERE p.transaction_id = t.id
               ), '[]'::json) AS payments
          FROM patti_transactions t
          LEFT JOIN parties pa ON pa.id = t.party_id
         WHERE t.id = $1
        `,
        [id]
    );
    return rows[0];
};

// ========= PDF renderer =========
const renderInvoicePdf = (doc, tx, { isPatti }) => {
    const invoiceType = isPatti ? 'INVOICE' : tx.bill_type === 'awaak'
        ? (tx.is_return ? 'PURCHASE RETURN' : 'PURCHASE')
        : (tx.is_return ? 'SALES RETURN' : 'SALES');
    // Register Devanagari font if available; fall back to Helvetica otherwise so the
    // endpoint still produces *something* in an environment missing the TTF.
    const hasDevanagari = fs.existsSync(FONT_PATH);
    if (hasDevanagari) {
        doc.registerFont('Dev', FONT_PATH);
    }
    const FONT = hasDevanagari ? 'Dev' : 'Helvetica';
    const FONT_BOLD = hasDevanagari ? 'Dev' : 'Helvetica-Bold';

    const PAGE_WIDTH = doc.page.width;
    const MARGIN = doc.page.margins.left; // default 30
    const INNER_W = PAGE_WIDTH - MARGIN * 2;

    // ---- HEADER ----
    doc.font(FONT_BOLD).fontSize(13).fillColor('#000').text('G1 Paints & Hardware', MARGIN, MARGIN - 8);
    doc.font(FONT).fontSize(8).fillColor('#555').text('Owner: Suresh Gornal · Vijapur', MARGIN, MARGIN + 4);
    doc.font(FONT_BOLD).fontSize(18).fillColor('#000').text(`${invoiceType} INVOICE`, MARGIN, MARGIN + 14);
    const rightX = PAGE_WIDTH - MARGIN;
    doc.font(FONT_BOLD).fontSize(11)
        .text(`Bill No: ${tx.bill_number || '-'}`, MARGIN, MARGIN + 2, {
            width: INNER_W,
            align: 'right'
        });
    doc.font(FONT).fontSize(10)
        .text(`Date: ${formatDate(tx.bill_date)}`, MARGIN, MARGIN + 16, {
            width: INNER_W,
            align: 'right'
        });

    const ruleY = MARGIN + 38;
    doc.moveTo(MARGIN, ruleY).lineTo(PAGE_WIDTH - MARGIN, ruleY).lineWidth(1.5).stroke();

    // ---- PARTY (centered) ----
    // Badge: smaller gray line above. Party name: bold large line below.
    // Mirrors PrintInvoice.tsx: badge span (16px gray) + party name (24px 900 black).
    const payments = Array.isArray(tx.payments) ? tx.payments : [];
    const hasCash = payments.some((p) => p && p.mode === 'cash');
    const hasOnline = payments.some((p) => p && p.mode === 'online');
    const badgeLabels = [];
    if (hasCash) badgeLabels.push('रोकड');
    if (hasOnline) badgeLabels.push('Online');

    let partyY = ruleY + 8;
    if (badgeLabels.length) {
        doc.font(FONT).fontSize(11).fillColor('#555')
           .text(`(${badgeLabels.join('/')})`, MARGIN, partyY, { width: INNER_W, align: 'center' });
        partyY += 16;
    }
    doc.font(FONT_BOLD).fontSize(18).fillColor('#000')
       .text(tx.party_name || '-', MARGIN, partyY, { width: INNER_W, align: 'center' });

    // ---- ITEMS TABLE ----
    // Customer invoice columns use the product's configured unit and quantity.
    const tableY = partyY + 28;
    const cols = [
        { key: 'sn',     title: '#',           w: 0.05, align: 'center' },
        { key: 'name',   title: 'Product',   w: 0.36, align: 'left'   },
        { key: 'unit',   title: 'Unit',      w: 0.11, align: 'center' },
        { key: 'weight', title: 'Quantity',  w: 0.14, align: 'center' },
        { key: 'rate',   title: 'दर',          w: 0.14, align: 'right'  },
        { key: 'total',  title: 'एकूण रक्कम', w: 0.20, align: 'right'  },
    ];

    let x0 = MARGIN;
    const colX = cols.map((c) => {
        const x = x0;
        x0 += c.w * INNER_W;
        return { ...c, x, w: c.w * INNER_W };
    });

    const drawRow = (y, values, { bold = false, height = 20 } = {}) => {
        doc.font(bold ? FONT_BOLD : FONT).fontSize(10).fillColor('#000');
        colX.forEach((c, i) => {
            const val = values[i] == null ? '' : String(values[i]);
            doc.text(val, c.x + 3, y + 5, {
                width: c.w - 6,
                align: c.align,
                ellipsis: false,
            });
        });
        return y + height;
    };

    // Table header
    doc.moveTo(MARGIN, tableY).lineTo(PAGE_WIDTH - MARGIN, tableY).lineWidth(0.75).stroke();
    const headerEndY = drawRow(tableY, cols.map((c) => c.title), { bold: true, height: 26 });
    doc.moveTo(MARGIN, headerEndY).lineTo(PAGE_WIDTH - MARGIN, headerEndY).lineWidth(0.75).stroke();

    // Group items by mirchi_name + rate + lot (same logic as PrintInvoice.tsx)
    const groups = {};
    for (const it of tx.items || []) {
        const key = `${it.mirchi_name}|${it.unit || 'kg'}|${toNum(it.rate_per_kg)}|${it.lot_number || ''}`;
        if (!groups[key]) {
            groups[key] = {
                mirchi_name: it.product_name || it.mirchi_name || '-',
                rate_per_kg: toNum(it.rate_per_kg),
                unit: it.unit || 'kg',
                lot_number: it.lot_number || '',
                quality: it.quality || '',
                poti_count: 0,
                net_weight: 0,
                weights: [],
            };
        }
        groups[key].poti_count += toNum(it.poti_count);
        groups[key].net_weight += toNum(it.net_weight);
        const pw = it.poti_weights;
        let arr = [];
        if (Array.isArray(pw)) arr = pw;
        else if (typeof pw === 'string') {
            try { arr = JSON.parse(pw); } catch { arr = []; }
        }
        if (Array.isArray(arr)) groups[key].weights.push(...arr);
    }
    const displayItems = Object.values(groups);

    let rowY = headerEndY;
    displayItems.forEach((it, idx) => {
        const amount = it.net_weight * it.rate_per_kg;
        const nameLine = it.mirchi_name || '-';
        const weightsLine = '';

        // Row height: bold name line + optional small weights line
        const nameCol = colX[1];
        doc.font(FONT_BOLD).fontSize(10);
        const nameH = doc.heightOfString(nameLine, { width: nameCol.w - 6 });
        doc.font(FONT).fontSize(8);
        const wH = weightsLine ? doc.heightOfString(weightsLine, { width: nameCol.w - 6 }) : 0;
        const rowH = Math.max(22, nameH + wH + 10);

        // Draw all columns except product name with standard row values.
        doc.font(FONT).fontSize(10).fillColor('#000');
        const otherVals = [String(idx + 1), '', (it.unit === 'liter' ? 'L' : 'kg'), it.net_weight.toFixed(2),
                           formatINR(it.rate_per_kg), formatINR(amount)];
        colX.forEach((c, i) => {
            if (i === 1) return;
            doc.text(otherVals[i], c.x + 3, rowY + 5, { width: c.w - 6, align: c.align, ellipsis: false });
        });

        // Product column: line 1 bold (name), line 2 small gray (weights)
        doc.font(FONT_BOLD).fontSize(10).fillColor('#000')
           .text(nameLine, nameCol.x + 3, rowY + 5, { width: nameCol.w - 6, align: 'left', ellipsis: false });
        if (weightsLine) {
            doc.font(FONT).fontSize(8).fillColor('#555')
               .text(weightsLine, nameCol.x + 3, rowY + 5 + nameH + 1, { width: nameCol.w - 6, align: 'left', ellipsis: false });
            doc.fillColor('#000');
        }

        rowY += rowH;
        doc.moveTo(MARGIN, rowY).lineTo(PAGE_WIDTH - MARGIN, rowY).lineWidth(0.25)
            .strokeColor('#cccccc').stroke().strokeColor('#000');
    });

    // ---- TOTALS — single right-aligned table matching HTML preview ----
    const totalsY = rowY + 12;
    const exp = tx.expenses || {};
    const subtotal = toNum(tx.subtotal);
    const packing = isPatti ? toNum(exp.packing) : toNum(exp.poti_amount);
    const cess    = isPatti ? toNum(exp.godown)   : toNum(exp.cess_amount);
    const adat    = isPatti ? toNum(exp.commission): toNum(exp.adat_amount);
    const hamali  = isPatti ? toNum(exp.hamali)   : (toNum(exp.hamali_amount) + toNum(exp.packaging_hamali_amount));
    const gaadi   = isPatti ? toNum(exp.gaadi_bhade) : toNum(exp.gaadi_bharni);
    const other   = toNum(exp.other_expenses);
    const grandTotal = toNum(tx.total_amount) || (subtotal + packing + cess + adat + hamali + gaadi + other);
    const gaadiNumber = (exp.gaadi_number || '').toString().trim();

    // Build rows in the same order/conditions as the HTML preview
    const summaryRows = [];
    if (packing > 0) summaryRows.push({ label: 'Packaging / handling', val: formatINR(packing), bold: false });
    summaryRows.push({ label: 'एकूण', val: formatINR(subtotal + packing), bold: true, topBorder: true });
    if (cess > 0)    summaryRows.push({ label: 'सेस',         val: formatINR(cess),   bold: false });
    if (adat > 0)    summaryRows.push({ label: 'अडत',         val: formatINR(adat),   bold: false });
    if (hamali > 0)  summaryRows.push({ label: 'हमाली',      val: formatINR(hamali), bold: false });
    if (gaadi > 0)   summaryRows.push({ label: 'गाडी भरणी',  val: formatINR(gaadi),  bold: false });
    if (gaadiNumber) summaryRows.push({ label: 'गाडी नंबर',  val: gaadiNumber,        bold: false });
    if (other > 0)   summaryRows.push({ label: 'इतर खर्च',   val: formatINR(other),  bold: false });
    summaryRows.push({ label: 'पूर्ण रक्कम', val: formatINR(grandTotal), bold: true, dashedBottom: true });

    // Payment rows: जमा header + individual modes + बाकी
    const actualPayments = payments.filter((p) => p && p.mode !== 'due');
    const actualPaid = actualPayments.reduce((s, p) => s + toNum(p.amount), 0);
    const due = grandTotal - actualPaid;
    summaryRows.push({ label: 'जमा', val: formatINR(actualPaid), bold: true });
    for (const p of actualPayments) {
        const modeLabel = p.mode === 'cash' ? 'रोख (Cash)'
                        : p.mode === 'online' ? 'Online'
                        : p.mode === 'cheque' ? 'Cheque'
                        : String(p.mode);
        summaryRows.push({ label: modeLabel, val: formatINR(toNum(p.amount)), bold: false, indent: true });
    }
    if (due > 0.001) summaryRows.push({ label: 'बाकी (Due)', val: formatINR(due), bold: false });

    // ---- Magil Baki + Total Baki — Ledger-PDF running balance ----
    // Magil Baki = past_due + party_balance_before_bill (chronological walk
    // of prior bills + jama, computed server-side — same as Ledger PDF YENE).
    // Total Baki = Magil Baki ± this bill's balance_amount (− for returns).
    // Fallback: if the field is missing on the tx, fall back to past_due only.
    const _pastDue = toNum(tx.party_past_due);
    const _balanceAmount = toNum(tx.balance_amount);
    const _hasBeforeBalance = tx.party_balance_before_bill !== undefined && tx.party_balance_before_bill !== null;
    const _balanceBefore = toNum(tx.party_balance_before_bill);
    const _billOutstandingChange = tx.is_return ? -_balanceAmount : _balanceAmount;
    const magilBaki = _hasBeforeBalance ? (_pastDue + _balanceBefore) : _pastDue;
    const totalBaki = magilBaki + _billOutstandingChange;
    summaryRows.push({ label: 'मागील बाकी (Magil Baki)', val: formatINR(magilBaki), bold: false });
    summaryRows.push({ label: 'एकूण बाकी (Total Baki)', val: formatINR(totalBaki), bold: true, red: true, topBorder: true });

    // Render right-aligned, 55% width — no box borders
    const tblW  = INNER_W * 0.55;
    const tblX  = PAGE_WIDTH - MARGIN - tblW;
    const labelW = tblW * 0.55;
    const valW   = tblW * 0.45;
    const ROW_H  = 18;
    let sY = totalsY;

    for (const r of summaryRows) {
        if (r.topBorder) {
            doc.moveTo(tblX, sY).lineTo(tblX + tblW, sY)
               .lineWidth(0.75).strokeColor('#333').stroke().strokeColor('#000');
        }
        const color = r.red ? '#d32f2f' : '#000';
        doc.font(r.bold ? FONT_BOLD : FONT).fontSize(r.bold ? 11 : 10).fillColor(color);
        doc.text(r.label, tblX + (r.indent ? 8 : 4), sY + 4,
                 { width: labelW - 8, align: 'left',  ellipsis: false });
        doc.text(r.val,   tblX + labelW,              sY + 4,
                 { width: valW  - 4, align: 'right', ellipsis: false });
        sY += ROW_H;
        if (r.dashedBottom) {
            doc.moveTo(tblX, sY).lineTo(tblX + tblW, sY)
               .lineWidth(0.5).dash(3, { space: 3 }).strokeColor('#ccc').stroke()
               .undash().strokeColor('#000');
        }
    }
    // No footer / signature — matches HTML preview exactly
};

// ========= routes =========
router.get('/invoice/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const source = req.query.source === 'patti' ? 'patti' : 'regular';
        const tx = source === 'patti' ? await loadPatti(id) : await loadRegular(id);

        if (!tx) {
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        const doc = new PDFDocument({ size: 'A5', margin: 30, info: {
            Title: `Invoice ${tx.bill_number || ''}`,
            Author: 'G1 Paints & Hardware',
            Subject: `Invoice for ${tx.party_name || ''}`,
        } });

        const safePartyName = (tx.party_name || 'Party')
            .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'Party';
        const filename = `Invoice_${safePartyName}_${tx.bill_number || id}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');

        doc.pipe(res);
        renderInvoicePdf(doc, tx, { isPatti: source === 'patti' });
        doc.end();
    } catch (error) {
        console.error('Error generating invoice PDF:', error);
        // If headers already sent via doc.pipe, we can't reply with JSON — but the stream will end.
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
});

// ========= Patti lot sale-sheet PDF =========
// Matches the handwritten sheet style: 4 columns — रक्कम / पोती / वजन / दर — and a total row.

const loadPattiLot = async (lotId) => {
    const { rows } = await pool.query(
        `SELECT id, lot_number, mirchi_name, total_quantity, remaining_quantity
           FROM patti_lots WHERE id = $1`,
        [lotId]
    );
    return rows[0];
};

const loadPattiLotSales = async (lotId) => {
    const { rows } = await pool.query(
        `SELECT ti.id,
                ti.poti_count,
                ti.net_weight,
                ti.rate_per_kg,
                ti.item_total,
                t.bill_number,
                t.bill_date,
                t.bill_type,
                COALESCE(t.is_return, false) AS is_return
           FROM patti_transaction_items ti
           JOIN patti_transactions t ON t.id = ti.transaction_id
          WHERE ti.lot_id = $1
            AND t.bill_type = 'patti_jawaak'
          ORDER BY t.bill_date ASC, t.created_at ASC`,
        [lotId]
    );
    return rows;
};

const renderPattiLotPdf = (doc, lot, rows) => {
    const hasDevanagari = fs.existsSync(FONT_PATH);
    if (hasDevanagari) doc.registerFont('Dev', FONT_PATH);
    const FONT = hasDevanagari ? 'Dev' : 'Helvetica';
    const FONT_BOLD = hasDevanagari ? 'Dev' : 'Helvetica-Bold';

    const PAGE_WIDTH = doc.page.width;
    const MARGIN = doc.page.margins.left;
    const INNER_W = PAGE_WIDTH - MARGIN * 2;

    // ---- Header: mirchi name left, total bags right (like the handwritten sheet) ----
    const totalBagsSold = rows.reduce((s, r) => s + (r.is_return ? -toNum(r.poti_count) : toNum(r.poti_count)), 0);
    const totalWeight = rows.reduce((s, r) => s + (r.is_return ? -toNum(r.net_weight) : toNum(r.net_weight)), 0);
    const totalAmount = rows.reduce((s, r) => s + (r.is_return ? -toNum(r.item_total) : toNum(r.item_total)), 0);

    doc.font(FONT_BOLD).fontSize(20).fillColor('#000')
        .text(lot.mirchi_name || '-', MARGIN, MARGIN, { width: INNER_W * 0.6, align: 'left' });
    doc.font(FONT_BOLD).fontSize(18)
        .text(`${totalBagsSold}   पोती`, MARGIN + INNER_W * 0.6, MARGIN + 2,
              { width: INNER_W * 0.4, align: 'right' });

    // Lot number subheading
    doc.font(FONT).fontSize(10).fillColor('#555')
        .text(`Lot: ${lot.lot_number || '-'}`, MARGIN, MARGIN + 28, { width: INNER_W, align: 'left' });

    const ruleY = MARGIN + 48;
    doc.moveTo(MARGIN, ruleY).lineTo(PAGE_WIDTH - MARGIN, ruleY).lineWidth(1.5).strokeColor('#000').stroke();

    // ---- Table ----
    // Bumped # column from 8% to 10% so serial tags like "12 R" have breathing room.
    const cols = [
        { key: 'sn',     title: '#',      w: 0.10, align: 'center' },
        { key: 'amount', title: 'रक्कम',  w: 0.28, align: 'right' },
        { key: 'unit',   title: 'Unit',      w: 0.11, align: 'center' },
        { key: 'weight', title: 'वजन',    w: 0.22, align: 'center' },
        { key: 'rate',   title: 'दर',     w: 0.22, align: 'right' },
    ];
    let x = MARGIN;
    const colX = cols.map((c) => {
        const col = { ...c, x, w: c.w * INNER_W };
        x += c.w * INNER_W;
        return col;
    });

    const tableTop = ruleY + 8;
    let rowY = tableTop;

    // Cell renderer — lineBreak:false stops pdfkit from wrapping when text is
    // ever so slightly wider than the cell (which was producing the "Tot / ा" split).
    const drawCell = (text, col, y, opts = {}) => {
        doc.text(text, col.x + 3, y + 4, {
            width: col.w - 6,
            align: col.align,
            lineBreak: false,
            ellipsis: false,
            ...opts,
        });
    };

    // Header row
    doc.font(FONT_BOLD).fontSize(11).fillColor('#000');
    colX.forEach((c) => drawCell(c.title, c, rowY));
    rowY += 20;
    doc.moveTo(MARGIN, rowY).lineTo(PAGE_WIDTH - MARGIN, rowY).lineWidth(0.75).stroke();

    // Body rows — paginate when we run out of vertical space
    doc.font(FONT).fontSize(11);
    const ROW_H = 18;
    const pageBottom = () => doc.page.height - doc.page.margins.bottom - 40;

    rows.forEach((r, idx) => {
        if (rowY + ROW_H > pageBottom()) {
            doc.addPage();
            rowY = doc.page.margins.top;
            doc.font(FONT_BOLD).fontSize(11);
            colX.forEach((c) => drawCell(c.title, c, rowY));
            rowY += 20;
            doc.moveTo(MARGIN, rowY).lineTo(PAGE_WIDTH - MARGIN, rowY).lineWidth(0.75).stroke();
            doc.font(FONT).fontSize(11);
        }

        const sign = r.is_return ? -1 : 1;
        const poti = sign * toNum(r.poti_count);
        const weight = sign * toNum(r.net_weight);
        const amount = sign * toNum(r.item_total);
        const rate = toNum(r.rate_per_kg);
        const tag = r.is_return ? ' R' : '';

        const values = [
            `${idx + 1}${tag}`,
            amount.toFixed(0),
            poti.toString(),
            weight.toFixed(2),
            rate.toFixed(0),
        ];
        if (r.is_return) doc.fillColor('#b91c1c');
        colX.forEach((c, i) => drawCell(values[i], c, rowY));
        doc.fillColor('#000');
        rowY += ROW_H;
        doc.moveTo(MARGIN, rowY).lineTo(PAGE_WIDTH - MARGIN, rowY)
            .lineWidth(0.25).strokeColor('#cccccc').stroke().strokeColor('#000');
    });

    // ---- Total row ----
    // Render the label BELOW the # column width so it can span the left side
    // without wrapping. Numeric cells stay aligned to their actual columns.
    if (rowY + 28 > pageBottom()) {
        doc.addPage();
        rowY = doc.page.margins.top;
    }
    rowY += 6;
    doc.moveTo(MARGIN, rowY).lineTo(PAGE_WIDTH - MARGIN, rowY).lineWidth(1.25).strokeColor('#000').stroke();
    rowY += 4;
    doc.font(FONT_BOLD).fontSize(12).fillColor('#000');

    // Label spans the # column + part of the रक्कम column (left-aligned, no wrap).
    doc.text('एकूण  (Total)', MARGIN + 4, rowY + 4, {
        width: colX[0].w + colX[1].w * 0.4,
        align: 'left',
        lineBreak: false,
        ellipsis: false,
    });
    // Amount: right-aligned inside the रक्कम column
    drawCell(totalAmount.toFixed(0), colX[1], rowY);
    // Poti: center-aligned inside the पोती column
    drawCell(totalBagsSold.toString(), colX[2], rowY);
    // Weight: center-aligned inside the वजन column
    drawCell(totalWeight.toFixed(2), colX[3], rowY);
    // Rate column intentionally blank — no total for per-kg rate

    rowY += 24;
    doc.moveTo(MARGIN, rowY).lineTo(PAGE_WIDTH - MARGIN, rowY).lineWidth(1.25).strokeColor('#000').stroke();

    // ---- Settlement block: fixed labels, blank number slots filled in by hand ----
    // Left: पॅकिंग / पट्टी / वजा / देणे. Bottom-right: हमाली / भाडे / आडवानस / कमिशन / total.
    const BLOCK_H = 230;
    if (rowY + BLOCK_H > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        rowY = doc.page.margins.top;
    }
    const slotW = INNER_W * 0.30;
    const blank = (x0, y0, w) => doc.moveTo(x0, y0).lineTo(x0 + w, y0).lineWidth(0.75).strokeColor('#000').stroke();
    const dashed = (x0, y0, w) => doc.moveTo(x0, y0).lineTo(x0 + w, y0).dash(3, { space: 2 }).lineWidth(0.75).stroke().undash();

    doc.font(FONT_BOLD).fontSize(14).fillColor('#000');
    const leftX = MARGIN + INNER_W * 0.12;
    const labelX = leftX + slotW + 14;
    const settleRow = (label, y) => {
        blank(leftX, y + 16, slotW);
        doc.text(label, labelX, y, { lineBreak: false });
    };
    let y = rowY + 14;
    settleRow('पॅकिंग', y);
    y += 28; dashed(leftX, y, slotW + 70);
    y += 8;  settleRow('पट्टी', y);
    y += 26; settleRow('वजा', y);
    y += 28; dashed(leftX, y, slotW + 70);
    y += 10;
    doc.roundedRect(leftX - 6, y - 4, slotW + 80, 26, 6).lineWidth(1.25).stroke();
    settleRow('देणे', y);

    // Deductions (वजा) breakdown
    doc.font(FONT_BOLD).fontSize(12);
    const rLabelX = MARGIN + INNER_W * 0.52;
    const rSlotX = MARGIN + INNER_W * 0.76;
    const rSlotW = INNER_W * 0.24;
    let ry = y + 40;
    ['हमाली', 'भाडे', 'आडवानस', 'कमिशन'].forEach((label) => {
        doc.text(label, rLabelX, ry, { lineBreak: false });
        blank(rSlotX, ry + 14, rSlotW);
        ry += 20;
    });
    ry += 4; dashed(rSlotX, ry, rSlotW);
    blank(rSlotX, ry + 22, rSlotW);
};

router.get('/patti-lot/:lotId', async (req, res) => {
    try {
        const { lotId } = req.params;
        const lot = await loadPattiLot(lotId);
        if (!lot) {
            return res.status(404).json({ success: false, message: 'Patti lot not found' });
        }
        const rows = await loadPattiLotSales(lotId);

        const doc = new PDFDocument({
            size: 'A5',
            margin: 30,
            info: {
                Title: `Patti Lot ${lot.lot_number || ''}`,
                Author: 'G1 Paints & Hardware - Suresh Gornal, Vijapur',
                Subject: `Sales sheet for lot ${lot.lot_number || ''}`,
            },
        });

        const safeLot = (lot.lot_number || 'Lot').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'Lot';
        const filename = `PattiLot_${safeLot}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');

        doc.pipe(res);
        renderPattiLotPdf(doc, lot, rows);
        doc.end();
    } catch (error) {
        console.error('Error generating patti lot PDF:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
});

// Export loaders so the public invoice-view route can reuse them without
// duplicating the lateral-subquery SQL.
module.exports = router;
module.exports.loadRegular = loadRegular;
module.exports.loadPatti = loadPatti;
module.exports.formatINR = formatINR;
module.exports.formatDate = formatDate;
module.exports.BALANCE_BEFORE_BILL_SQL = BALANCE_BEFORE_BILL_SQL;
