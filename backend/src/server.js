const express = require('express');
const cors = require('cors');
const compression = require('compression');
const http = require('http');
require('dotenv').config();

const partiesRouter = require('./routes/parties');
const productsRouter = require('./routes/mirchiTypes');
const lotsRouter = require('./routes/lots');
const transactionsRouter = require('./routes/transactions');
const jamaRouter = require('./routes/jama');
const pattiRouter = require('./routes/patti');
const dashboardRouter = require('./routes/dashboard');
const pdfRouter = require('./routes/pdf');
const invoiceViewRouter = require('./routes/invoice-view');
const invoiceImageUploadRouter = require('./routes/invoice-image-upload');

const app = express();
const PORT = process.env.PORT || 4000;

// HF Spaces (and any other reverse-proxy host) terminate TLS upstream and
// forward plain HTTP to this process. Without trust proxy, req.protocol
// stays 'http', so the absolute og:image URL in /invoice/view/:id ends up
// http:// — WhatsApp's crawler refuses or downgrades that. Trust the
// X-Forwarded-Proto header so we generate https:// URLs in production.
app.set('trust proxy', true);

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Routes
app.use('/api/parties', partiesRouter);
app.use('/api/products', productsRouter);
app.use('/api/lots', lotsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/jama', jamaRouter);
app.use('/api/patti', pattiRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/pdf', pdfRouter);

// Accepts PNG blobs of the rendered invoice from the frontend (html2canvas
// of the PdfInvoice DOM) and writes them to /data/invoices/<id>.png. The
// og-image route below prefers this uploaded PNG over its canvas fallback.
app.use('/api/invoice-image', invoiceImageUploadRouter);

// Public, no-auth invoice view + OG image PNG — mounted at top-level so
// WhatsApp's link-preview crawler (and the recipient) can resolve it.
app.use('/invoice', invoiceViewRouter);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'G1 Paints & Hardware Inventory API',
        version: '1.0.0',
        endpoints: {
            parties: '/api/parties',
            products: '/api/products',
            lots: '/api/lots',
            transactions: '/api/transactions'
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        success: false,
        message: err.message || 'Internal server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 API available at http://localhost:${PORT}`);
    console.log(`💚 Health check: http://localhost:${PORT}/health`);

    // Self-ping every 35 minutes to prevent HF Spaces from sleeping.
    // GET /health makes no DB queries — zero risk to data.
    const KEEPALIVE_MS = 35 * 60 * 1000;
    setInterval(() => {
        http.get(`http://localhost:${PORT}/health`, (res) => {
            console.log(`[keepalive] ping OK ${new Date().toISOString()} (${res.statusCode})`);
            res.resume();
        }).on('error', (err) => {
            console.warn(`[keepalive] ping failed: ${err.message}`);
        });
    }, KEEPALIVE_MS);
});

module.exports = app;
