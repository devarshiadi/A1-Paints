/**
 * Public invoice view + Open Graph image.
 *
 * WhatsApp pre-targets a contact via wa.me/<phone>?text=... but cannot carry
 * file attachments. Instead we send a public URL to this view; WhatsApp's
 * link-preview crawler fetches the og:image and renders an inline thumbnail
 * of the invoice in the chat bubble.
 *
 * Routes (mounted at top-level `/invoice`, NOT under /api):
 *   GET /invoice/view/:id          → SSR HTML with og:* meta tags
 *   GET /invoice/og-image/:id.png  → PNG render of invoice for og:image
 *
 * Cache strategy: PNGs cached on disk at .cache/og/<id>_<updatedAtKey>.png
 * keyed by the transaction's updated_at — invoice edits bust the cache
 * automatically. WhatsApp's crawler hits this endpoint dozens of times for
 * popular links; disk cache makes repeat fetches ~free.
 *
 * No auth — WhatsApp's crawler and any recipient must reach this. The
 * frontend LoginGate only protects the data-entry UI.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();

const { loadRegular, loadPatti, formatINR, formatDate } = require('./pdf');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// Register the Devanagari font so canvas can render Marathi text without
// boxes. Falls back to sans-serif when the file is missing.
const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansDevanagari.ttf');
let DEVA_FONT = null;
try {
    if (fs.existsSync(FONT_PATH)) {
        GlobalFonts.registerFromPath(FONT_PATH, 'Devanagari');
        DEVA_FONT = 'Devanagari';
    }
} catch (e) {
    console.warn('[invoice-view] could not register Devanagari font:', e.message);
}

const CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'og');
try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch (e) { /* ignore — written-on-first-use */ }

const escapeHtml = (s) =>
    String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

const detectSource = (id) => (id && String(id).endsWith('-patti') ? 'patti' : 'regular');

const loadTx = async (id) => {
    const source = detectSource(id);
    const tx = source === 'patti' ? await loadPatti(id) : await loadRegular(id);
    return { tx, source };
};

const buildAbsoluteUrl = (req, p) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}${p}`;
};

// ----------------------------- HTML page -----------------------------

router.get('/view/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { tx, source } = await loadTx(id);
        if (!tx) return res.status(404).send('<h1>Invoice not found</h1>');

        // -------- Numbers (mirrors PrintInvoice.tsx:25-45 logic) --------
        const isPatti = source === 'patti';
        const isMixed = !!tx.is_mixed;
        const billTypeLabel = isMixed ? 'INVOICE' : (isPatti ? 'INVOICE' : tx.bill_type === 'awaak'
            ? (tx.is_return ? 'PURCHASE RETURN' : 'PURCHASE')
            : (tx.is_return ? 'SALES RETURN' : 'SALES'));
        const exp = tx.expenses || {};
        const subtotal     = toNum(tx.subtotal);
        const packing      = isPatti ? toNum(exp.packing)    : toNum(exp.poti_amount);
        const cess         = isPatti ? toNum(exp.godown)     : toNum(exp.cess_amount);
        const adat         = isPatti ? toNum(exp.commission) : toNum(exp.adat_amount);
        const hamali       = isPatti ? toNum(exp.hamali)     : (toNum(exp.hamali_amount) + toNum(exp.packaging_hamali_amount));
        const gaadiBharni  = isPatti ? toNum(exp.gaadi_bhade): toNum(exp.gaadi_bharni);
        const gaadiNumber  = (exp.gaadi_number || '').toString().trim();
        const otherExpenses = toNum(exp.other_expenses);
        const grandTotal   = toNum(tx.total_amount) || (subtotal + packing + cess + adat + hamali + gaadiBharni + otherExpenses);
        const paidAmount    = toNum(tx.paid_amount);
        const balanceAmount = toNum(tx.balance_amount);
        // Magil Baki = past_due + party_balance_before_bill (Ledger PDF YENE).
        const _pastDue_v       = toNum(tx.party_past_due);
        const _hasBefore_v     = tx.party_balance_before_bill !== undefined && tx.party_balance_before_bill !== null;
        const _balanceBefore_v = toNum(tx.party_balance_before_bill);
        const _billChange_v    = tx.is_return ? -balanceAmount : balanceAmount;
        const magilBaki    = _hasBefore_v ? (_pastDue_v + _balanceBefore_v) : _pastDue_v;
        const totalBaki    = magilBaki + _billChange_v;

        const payments = Array.isArray(tx.payments) ? tx.payments : [];
        const hasCash   = payments.some((p) => p && p.mode === 'cash');
        const hasOnline = payments.some((p) => p && p.mode === 'online');
        const badgeLabels = [];
        if (hasCash) badgeLabels.push('रोकड');
        if (hasOnline) badgeLabels.push('Online');

        const displayItems = groupItems(tx.items || []);

        const ogImageUrl = buildAbsoluteUrl(req, `/invoice/og-image/${encodeURIComponent(id)}.png`);
        const canonical  = buildAbsoluteUrl(req, `/invoice/view/${encodeURIComponent(id)}`);
        const pdfUrl     = buildAbsoluteUrl(req, `/api/pdf/invoice/${encodeURIComponent(id)}?source=${source}`);

        const titleStr = `G1 Paints & Hardware | Invoice ${tx.bill_number || ''} — ${tx.party_name || ''}`;
        const descStr  = `Total ₹${grandTotal.toFixed(0)} · Due ₹${totalBaki.toFixed(0)} · ${formatDate(tx.bill_date)}`;

        const inr = (v) => `₹${toNum(v).toFixed(2)}`;

        // -------- Item rows --------
        const itemRowsHtml = displayItems.map((it, idx) => {
            
            const amount = it.net_weight * it.rate_per_kg;
            return `<tr>
                <td style="padding:10px 4px;text-align:left;border-bottom:1px dashed #eee;">${idx + 1}</td>
                <td style="padding:10px 4px;text-align:left;border-bottom:1px dashed #eee;">
                  <div style="font-weight:500;color:#333;">${escapeHtml(it.product_name || it.mirchi_name || '-')}</div>
                </td>
                <td style="padding:10px 4px;text-align:center;border-bottom:1px dashed #eee;color:#444;">${it.unit === 'liter' ? 'L' : 'kg'}</td>
                <td style="padding:10px 4px;text-align:center;border-bottom:1px dashed #eee;color:#444;">${toNum(it.net_weight).toFixed(2)}</td>
                <td style="padding:10px 4px;text-align:right;border-bottom:1px dashed #eee;color:#444;">${inr(it.rate_per_kg)}</td>
                <td style="padding:10px 4px;text-align:right;border-bottom:1px dashed #eee;font-weight:500;">${inr(amount)}</td>
              </tr>`;
        }).join('');

        // -------- Summary rows (totals block) --------
        const summaryRowsHtml = [
            packing > 0 && `<tr>
                <td style="padding:4px;text-align:left;border-bottom:1px solid #eee;color:#555;">Packaging / handling</td>
                <td style="padding:4px;text-align:right;border-bottom:1px solid #eee;">${inr(packing)}</td>
              </tr>`,
            `<tr>
                <td style="padding:6px 4px;text-align:left;border-top:1px solid #333;font-size:14px;font-weight:bold;">एकूण</td>
                <td style="padding:6px 4px;text-align:right;border-top:1px solid #333;font-weight:bold;">${inr(subtotal + packing)}</td>
              </tr>`,
            cess > 0 && `<tr>
                <td style="padding:4px;text-align:left;border-bottom:1px solid #eee;color:#555;">सेस</td>
                <td style="padding:4px;text-align:right;border-bottom:1px solid #eee;">${inr(cess)}</td>
              </tr>`,
            adat > 0 && `<tr>
                <td style="padding:4px;text-align:left;border-bottom:1px solid #eee;color:#555;">अडत</td>
                <td style="padding:4px;text-align:right;border-bottom:1px solid #eee;">${inr(adat)}</td>
              </tr>`,
            hamali > 0 && `<tr>
                <td style="padding:4px;text-align:left;border-bottom:1px solid #eee;color:#555;">हमाली</td>
                <td style="padding:4px;text-align:right;border-bottom:1px solid #eee;">${inr(hamali)}</td>
              </tr>`,
            gaadiBharni > 0 && `<tr>
                <td style="padding:4px;text-align:left;border-bottom:1px solid #eee;color:#555;">गाडी भरणी</td>
                <td style="padding:4px;text-align:right;border-bottom:1px solid #eee;">${inr(gaadiBharni)}</td>
              </tr>`,
            gaadiNumber && `<tr>
                <td style="padding:4px;text-align:left;border-bottom:1px solid #eee;color:#555;">गाडी नंबर</td>
                <td style="padding:4px;text-align:right;border-bottom:1px solid #eee;font-weight:600;">${escapeHtml(gaadiNumber)}</td>
              </tr>`,
            otherExpenses > 0 && `<tr>
                <td style="padding:4px;text-align:left;border-bottom:1px solid #eee;color:#555;">इतर खर्च</td>
                <td style="padding:4px;text-align:right;border-bottom:1px solid #eee;">${inr(otherExpenses)}</td>
              </tr>`,
            `<tr>
                <th style="padding:8px 4px;text-align:left;font-size:16px;font-weight:bold;border-bottom:1px dashed #ccc;">पूर्ण रक्कम</th>
                <th style="padding:8px 4px;text-align:right;font-size:16px;font-weight:bold;border-bottom:1px dashed #ccc;">${inr(grandTotal)}</th>
              </tr>`,
            `<tr>
                <td style="padding:4px;text-align:left;font-weight:bold;">जमा</td>
                <td style="padding:4px;text-align:right;font-weight:bold;">${inr(paidAmount)}</td>
              </tr>`,
            ...payments.filter((p) => p && p.mode !== 'due').map((p) => {
                const label = p.mode === 'cash' ? 'रोख (Cash)'
                            : p.mode === 'online' ? 'Online'
                            : p.mode === 'cheque' ? 'Cheque'
                            : String(p.mode);
                return `<tr>
                    <td style="padding:2px 4px;text-align:left;color:#333;">${escapeHtml(label)}</td>
                    <td style="padding:2px 4px;text-align:right;">${inr(toNum(p.amount))}</td>
                  </tr>`;
            }),
            balanceAmount > 0 && `<tr>
                <td style="padding:4px;text-align:left;">बाकी (Due)</td>
                <td style="padding:4px;text-align:right;">${inr(balanceAmount)}</td>
              </tr>`,
            `<tr>
                <td style="padding:4px;text-align:left;">मागील बाकी (Magil Baki)</td>
                <td style="padding:4px;text-align:right;">${inr(magilBaki)}</td>
              </tr>`,
            `<tr>
                <td style="padding:6px 4px;text-align:left;font-weight:bold;color:#d32f2f;border-top:1px solid #333;">एकूण बाकी (Total Baki)</td>
                <td style="padding:6px 4px;text-align:right;font-weight:bold;color:#d32f2f;border-top:1px solid #333;">${inr(totalBaki)}</td>
              </tr>`,
        ].filter(Boolean).join('');

        // -------- Compose page --------
        // Faithful port of PrintInvoice.tsx:189-358. Outer wrapper is
        // responsive (max-width 640px, centred on mobile). Inner .invoice
        // keeps the same fixed-width-feeling A5 styling but fills 100% on
        // small screens. Google Fonts loads Noto Sans Devanagari so Marathi
        // text renders on any browser including stock Android.
        const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(titleStr)}</title>
    <meta name="description" content="${escapeHtml(descStr)}">
    <meta property="og:title" content="${escapeHtml(titleStr)}">
    <meta property="og:description" content="${escapeHtml(descStr)}">
    <meta property="og:image" content="${escapeHtml(ogImageUrl)}">
    <meta property="og:image:width" content="1080">
    <meta property="og:image:height" content="1528">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;500;700;900&display=swap" rel="stylesheet">
    <style>
      html, body { margin: 0; padding: 0; background: #f5f5f5; }
      body { font-family: 'Noto Sans Devanagari', Helvetica, Arial, sans-serif; min-height: 100vh; color: #000; }
      .wrap { max-width: 640px; margin: 0 auto; padding: 12px 12px 84px; }
      .invoice {
        background: #fff;
        padding: 16px;
        font-size: 12px;
        color: #000;
        box-shadow: 0 2px 12px rgba(0,0,0,0.08);
        border-radius: 6px;
      }
      .actions {
        position: fixed; left: 0; right: 0; bottom: 0;
        background: rgba(255,255,255,0.95);
        border-top: 1px solid #e5e7eb;
        padding: 12px;
        display: flex; justify-content: center; gap: 12px;
        backdrop-filter: blur(6px);
      }
      .btn {
        display: inline-block; padding: 12px 24px; border-radius: 8px;
        text-decoration: none; font-weight: 600; font-size: 0.95rem;
      }
      .btn.primary { background: #2563eb; color: white; }
      .btn.primary:active { background: #1d4ed8; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="invoice">
        <!-- Invoice Header -->
        <div style="border-bottom:2px solid #333;padding-bottom:10px;margin-bottom:15px;display:flex;justify-content:space-between;align-items:flex-end;">
          <div>
            <div style="font-size:17px;font-weight:bold;">G1 Paints &amp; Hardware</div>
            <div style="font-size:11px;color:#555;margin-top:2px;">Owner: Suresh Gornal · Vijapur</div>
            <h1 style="margin:2px 0 0;font-size:23px;font-weight:bold;letter-spacing:1px;">${escapeHtml(billTypeLabel)} INVOICE</h1>
          </div>
          <div style="text-align:right;">
            <div style="font-size:14px;font-weight:bold;">Bill No: ${escapeHtml(tx.bill_number || '-')}</div>
            <div style="font-size:13px;margin-top:4px;">Date: ${escapeHtml(formatDate(tx.bill_date))}</div>
          </div>
        </div>

        <!-- Party Section -->
        <div style="text-align:center;margin-bottom:20px;">
          <div style="font-size:24px;font-weight:900;color:#000;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;">
            ${badgeLabels.length ? `<span style="font-size:16px;font-weight:normal;color:#555;">(${escapeHtml(badgeLabels.join('/'))})</span>` : ''}
            <span>${escapeHtml(tx.party_name || '-')}</span>
          </div>
        </div>

        <!-- Items Table -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
          <thead>
            <tr>
              <th style="border-bottom:1px solid #333;border-top:1px solid #333;padding:10px 4px;text-align:left;width:5%;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">#</th>
              <th style="border-bottom:1px solid #333;border-top:1px solid #333;padding:10px 4px;text-align:left;width:40%;font-size:14px;font-weight:bold;">Product</th>
              <th style="border-bottom:1px solid #333;border-top:1px solid #333;padding:10px 4px;text-align:center;width:10%;font-size:14px;font-weight:bold;">Unit</th>
              <th style="border-bottom:1px solid #333;border-top:1px solid #333;padding:10px 4px;text-align:center;width:15%;font-size:14px;font-weight:bold;">Quantity</th>
              <th style="border-bottom:1px solid #333;border-top:1px solid #333;padding:10px 4px;text-align:right;width:15%;font-size:14px;font-weight:bold;">Rate / unit</th>
              <th style="border-bottom:1px solid #333;border-top:1px solid #333;padding:10px 4px;text-align:right;width:15%;font-size:14px;font-weight:bold;">Amount</th>
            </tr>
          </thead>
          <tbody>${itemRowsHtml}</tbody>
        </table>

        <!-- Totals + Payments (right-aligned, 55% width) -->
        <div style="display:flex;justify-content:flex-end;">
          <div style="width:55%;min-width:260px;">
            <table style="width:100%;border-collapse:collapse;">
              <tbody>${summaryRowsHtml}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <a class="btn primary" href="${escapeHtml(pdfUrl)}">Download PDF</a>
    </div>
  </body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // Short browser cache so re-opens are fast; WhatsApp's crawler re-fetches anyway.
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.send(html);
    } catch (err) {
        console.error('[invoice-view] /view error:', err);
        res.status(500).send('<h1>Server error rendering invoice</h1>');
    }
});

// ------------------------- OG image PNG -----------------------------
//
// Canvas port of `renderInvoicePdf` in routes/pdf.js. Coordinates use PDF
// units (A5 = 420 × 595.28 pt, MARGIN = 30) and are scaled by S = 1080 / 420
// when drawn so the PNG is a literal 2.57× upscale of the printed invoice.
// Every section, font size, column width, border weight, and order matches
// the PDF — no redesign.

const PDF_W = 420;
const MARGIN = 30;
const INNER_W = PDF_W - MARGIN * 2; // 360
const S = 1080 / PDF_W;             // ≈ 2.571
const CANVAS_W = Math.round(PDF_W * S); // 1080

const RENDERER_VERSION = 'v2';

const cacheKey = (id, tx) => {
    const updated = tx.updated_at ? new Date(tx.updated_at).getTime() : 0;
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const hash = crypto.createHash('sha1')
        .update(`${safeId}_${updated}_${RENDERER_VERSION}`)
        .digest('hex')
        .slice(0, 10);
    return `${safeId}_${hash}.png`;
};

const groupItems = (items = []) => {
    const out = {};
    for (const it of items) {
        const productName = it.product_name || it.mirchi_name || '-';
        const k = `${productName}|${it.unit || 'kg'}|${toNum(it.rate_per_kg)}|${it.lot_number || ''}`;
        if (!out[k]) {
            out[k] = {
                product_name: productName,
                mirchi_name: productName,
                rate_per_kg: toNum(it.rate_per_kg),
                unit: it.unit || 'kg',
                lot_number: it.lot_number || '',
                poti_count: 0,
                net_weight: 0,
                weights: [],
            };
        }
        out[k].poti_count += toNum(it.poti_count);
        out[k].net_weight += toNum(it.net_weight);
        let arr = [];
        if (Array.isArray(it.poti_weights)) arr = it.poti_weights;
        else if (typeof it.poti_weights === 'string') {
            try { arr = JSON.parse(it.poti_weights); } catch { /* ignore */ }
        }
        if (Array.isArray(arr)) out[k].weights.push(...arr);
    }
    return Object.values(out);
};

const drawOgImage = (tx, source) => {
    const isPatti = source === 'patti';
    const payments = Array.isArray(tx.payments) ? tx.payments : [];

    // -------- Compute summary rows (same order/conditions as PDFKit) --------
    const exp = tx.expenses || {};
    const subtotal = toNum(tx.subtotal);
    const packing  = isPatti ? toNum(exp.packing)    : toNum(exp.poti_amount);
    const cess     = isPatti ? toNum(exp.godown)     : toNum(exp.cess_amount);
    const adat     = isPatti ? toNum(exp.commission) : toNum(exp.adat_amount);
    const hamali   = isPatti ? toNum(exp.hamali)     : (toNum(exp.hamali_amount) + toNum(exp.packaging_hamali_amount));
    const gaadi    = isPatti ? toNum(exp.gaadi_bhade): toNum(exp.gaadi_bharni);
    const other    = toNum(exp.other_expenses);
    const grandTotal = toNum(tx.total_amount) || (subtotal + packing + cess + adat + hamali + gaadi + other);
    const gaadiNumber = (exp.gaadi_number || '').toString().trim();

    const summaryRows = [];
    if (packing > 0) summaryRows.push({ label: 'Packaging / handling', val: formatINR(packing) });
    summaryRows.push({ label: 'एकूण', val: formatINR(subtotal + packing), bold: true, topBorder: true });
    if (cess > 0)    summaryRows.push({ label: 'सेस',         val: formatINR(cess) });
    if (adat > 0)    summaryRows.push({ label: 'अडत',         val: formatINR(adat) });
    if (hamali > 0)  summaryRows.push({ label: 'हमाली',       val: formatINR(hamali) });
    if (gaadi > 0)   summaryRows.push({ label: 'गाडी भरणी',   val: formatINR(gaadi) });
    if (gaadiNumber) summaryRows.push({ label: 'गाडी नंबर',   val: gaadiNumber });
    if (other > 0)   summaryRows.push({ label: 'इतर खर्च',    val: formatINR(other) });
    summaryRows.push({ label: 'पूर्ण रक्कम', val: formatINR(grandTotal), bold: true, dashedBottom: true });

    const actualPayments = payments.filter((p) => p && p.mode !== 'due');
    const actualPaid = actualPayments.reduce((s, p) => s + toNum(p.amount), 0);
    const due = grandTotal - actualPaid;
    summaryRows.push({ label: 'जमा', val: formatINR(actualPaid), bold: true });
    for (const p of actualPayments) {
        const modeLabel = p.mode === 'cash'   ? 'रोख (Cash)'
                        : p.mode === 'online' ? 'Online'
                        : p.mode === 'cheque' ? 'Cheque'
                        : String(p.mode);
        summaryRows.push({ label: modeLabel, val: formatINR(toNum(p.amount)), indent: true });
    }
    if (due > 0.001) summaryRows.push({ label: 'बाकी (Due)', val: formatINR(due) });

    // Magil Baki = past_due + party_balance_before_bill (Ledger PDF YENE).
    const _pastDue_c       = toNum(tx.party_past_due);
    const _hasBefore_c     = tx.party_balance_before_bill !== undefined && tx.party_balance_before_bill !== null;
    const _balanceBefore_c = toNum(tx.party_balance_before_bill);
    const _billChange_c    = tx.is_return ? -toNum(tx.balance_amount) : toNum(tx.balance_amount);
    const magilBaki = _hasBefore_c ? (_pastDue_c + _balanceBefore_c) : _pastDue_c;
    summaryRows.push({ label: 'मागील बाकी (Magil Baki)', val: formatINR(magilBaki) });
    const totalBaki = magilBaki + _billChange_c;
    summaryRows.push({ label: 'एकूण बाकी (Total Baki)', val: formatINR(totalBaki), bold: true, red: true, topBorder: true });

    // -------- Compute item layout + total height (PDF pt) --------
    const displayItems = groupItems(tx.items || []);
    const headerBottom = MARGIN + 38; // INVOICE header + rule

    const badgeLabels = [];
    if (payments.some((p) => p && p.mode === 'cash'))   badgeLabels.push('रोकड');
    if (payments.some((p) => p && p.mode === 'online')) badgeLabels.push('Online');
    const partyOffset = badgeLabels.length ? 16 : 0;
    const partyY = headerBottom + 8 + partyOffset;
    const tableY = partyY + 28;

    // Each row: 22pt minimum, +12pt extra when a weights line is present
    const rowHeights = displayItems.map((it) =>
        it.weights && it.weights.length > 0 ? 34 : 24
    );
    const itemsH = rowHeights.reduce((s, h) => s + h, 0);
    const headerEndY = tableY + 26;
    const rowsEndY = headerEndY + itemsH;
    const totalsY = rowsEndY + 12;
    const ROW_H = 18;
    const totalsH = summaryRows.length * ROW_H;
    const bottomMargin = 24;
    const totalH_pt = totalsY + totalsH + bottomMargin;
    const canvasH = Math.max(Math.ceil(totalH_pt * S), 1080);

    // -------- Canvas setup --------
    const canvas = createCanvas(CANVAS_W, canvasH);
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, CANVAS_W, canvasH);

    const FONT_FAMILY = DEVA_FONT || 'sans-serif';

    const setFont = (sz, bold = false) => {
        ctx.font = `${bold ? 'bold ' : ''}${(sz * S).toFixed(1)}px ${FONT_FAMILY}`;
    };

    // PDFKit-style text positioning: align to the rect [x, y, width, ...].
    const textAt = (str, x, y, opts = {}) => {
        const { width, align = 'left', color = '#000' } = opts;
        ctx.fillStyle = color;
        ctx.textBaseline = 'top';
        if (align === 'right' && typeof width === 'number') {
            ctx.textAlign = 'right';
            ctx.fillText(String(str), (x + width) * S, y * S);
        } else if (align === 'center' && typeof width === 'number') {
            ctx.textAlign = 'center';
            ctx.fillText(String(str), (x + width / 2) * S, y * S);
        } else {
            ctx.textAlign = 'left';
            ctx.fillText(String(str), x * S, y * S);
        }
    };

    const lineAt = (x1, y1, x2, y2, lineWidth, color = '#000', dashed = false) => {
        ctx.beginPath();
        ctx.moveTo(x1 * S, y1 * S);
        ctx.lineTo(x2 * S, y2 * S);
        ctx.lineWidth = Math.max(1, lineWidth * S);
        ctx.strokeStyle = color;
        ctx.setLineDash(dashed ? [3 * S, 3 * S] : []);
        ctx.stroke();
        ctx.setLineDash([]);
    };

    // ---- HEADER (mirrors pdf.js:165-181) ----
    setFont(22, true);
    textAt('INVOICE', MARGIN, MARGIN);

    setFont(11, true);
    textAt(`Bill No: ${tx.bill_number || '-'}`, MARGIN, MARGIN + 2,
        { width: INNER_W, align: 'right' });

    setFont(10);
    const billTypeLabel = isPatti ? 'P' : 'R';
    textAt(`Date: ${formatDate(tx.bill_date)}  (${billTypeLabel})`, MARGIN, MARGIN + 16,
        { width: INNER_W, align: 'right' });

    lineAt(MARGIN, MARGIN + 38, PDF_W - MARGIN, MARGIN + 38, 1.5);

    // ---- PARTY (pdf.js:184-200) ----
    let py = MARGIN + 38 + 8;
    if (badgeLabels.length) {
        setFont(11);
        textAt(`(${badgeLabels.join('/')})`, MARGIN, py,
            { width: INNER_W, align: 'center', color: '#555' });
        py += 16;
    }
    setFont(18, true);
    textAt(tx.party_name || '-', MARGIN, py,
        { width: INNER_W, align: 'center', color: '#000' });

    // ---- ITEMS TABLE header (pdf.js:202-237) ----
    const cols = [
        { title: '#',            w: 0.05, align: 'center' },
        { title: 'Product',       w: 0.36, align: 'left'   },
        { title: 'Unit',          w: 0.11, align: 'center' },
        { title: 'Quantity',      w: 0.14, align: 'center' },
        { title: 'Rate / unit',   w: 0.14, align: 'right'  },
        { title: 'Amount',        w: 0.20, align: 'right'  },
    ];
    let cx = MARGIN;
    const colX = cols.map((c) => {
        const x = cx;
        const w = c.w * INNER_W;
        cx += w;
        return { ...c, x, w };
    });

    lineAt(MARGIN, tableY, PDF_W - MARGIN, tableY, 0.75);
    setFont(10, true);
    colX.forEach((c) => {
        textAt(c.title, c.x + 3, tableY + 5,
            { width: c.w - 6, align: c.align, color: '#000' });
    });
    lineAt(MARGIN, headerEndY, PDF_W - MARGIN, headerEndY, 0.75);

    // ---- TABLE ROWS (pdf.js:267-301) ----
    let rowY = headerEndY;
    displayItems.forEach((it, idx) => {
        const rowH = rowHeights[idx];
        const nameCol = colX[1];
        const amount = it.net_weight * it.rate_per_kg;

        // Non-product columns
        setFont(10);
        const otherVals = [
            String(idx + 1),
            null,
            it.unit === 'liter' ? 'L' : 'kg',
            it.net_weight.toFixed(2),
            formatINR(it.rate_per_kg),
            formatINR(amount),
        ];
        colX.forEach((c, i) => {
            if (i === 1) return;
            textAt(otherVals[i], c.x + 3, rowY + 5,
                { width: c.w - 6, align: c.align, color: '#000' });
        });

        // Product name (bold)
        setFont(10, true);
        textAt(it.mirchi_name || '-', nameCol.x + 3, rowY + 5,
            { width: nameCol.w - 6, align: 'left', color: '#000' });

        // Weights line (small grey)
        if (it.weights && it.weights.length > 0) {
            setFont(8);
            textAt(`Weights: ${it.weights.join(', ')}`,
                nameCol.x + 3, rowY + 5 + 13,
                { width: nameCol.w - 6, align: 'left', color: '#555' });
        }

        rowY += rowH;
        lineAt(MARGIN, rowY, PDF_W - MARGIN, rowY, 0.25, '#cccccc');
    });

    // ---- TOTALS BLOCK (pdf.js:303-374) ----
    const tblW   = INNER_W * 0.55;
    const tblX   = PDF_W - MARGIN - tblW;
    const labelW = tblW * 0.55;
    const valW   = tblW * 0.45;
    let sY = totalsY;

    for (const r of summaryRows) {
        if (r.topBorder) {
            lineAt(tblX, sY, tblX + tblW, sY, 0.75, '#333');
        }
        const color = r.red ? '#d32f2f' : '#000';
        setFont(r.bold ? 11 : 10, !!r.bold);
        textAt(r.label, tblX + (r.indent ? 8 : 4), sY + 4,
            { width: labelW - 8, align: 'left', color });
        textAt(r.val, tblX + labelW, sY + 4,
            { width: valW - 4, align: 'right', color });
        sY += ROW_H;
        if (r.dashedBottom) {
            lineAt(tblX, sY, tblX + tblW, sY, 0.5, '#ccc', true);
        }
    }

    return canvas.toBuffer('image/png');
};

// Persistent-storage directory shared with the upload route. Frontend pushes
// the html2canvas render here so the OG image is a pixel-perfect copy of the
// in-app invoice — backend canvas drawing only runs as a fallback when no
// upload exists yet.
const { STORAGE_DIR: UPLOAD_DIR } = require('./invoice-image-upload');

router.get('/og-image/:id.png', async (req, res) => {
    try {
        const id = decodeURIComponent(req.params.id);
        const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

        // 1. Prefer the frontend-uploaded PNG persisted to HF Storage at /data.
        const uploadedPath = path.join(UPLOAD_DIR, `${safeId}.png`);
        try {
            const png = await fs.promises.readFile(uploadedPath);
            res.setHeader('Content-Type', 'image/png');
            // Short cache so re-shares after payment edits propagate within minutes.
            res.setHeader('Cache-Control', 'public, max-age=300');
            return res.send(png);
        } catch { /* no uploaded image yet — fall through to canvas */ }

        // 2. Backend canvas fallback (Follow-up D), cached by tx.updated_at.
        const { tx, source } = await loadTx(id);
        if (!tx) return res.status(404).end();

        const cachePath = path.join(CACHE_DIR, cacheKey(id, tx));
        let png;
        if (fs.existsSync(cachePath)) {
            png = fs.readFileSync(cachePath);
        } else {
            png = drawOgImage(tx, source);
            try { fs.writeFileSync(cachePath, png); } catch (e) { /* read-only fs ok */ }
        }

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.send(png);
    } catch (err) {
        console.error('[invoice-view] /og-image error:', err);
        res.status(500).end();
    }
});

module.exports = router;
