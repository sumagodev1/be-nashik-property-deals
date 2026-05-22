require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const apiRouter = require('./server/routes');
const { notFound, errorHandler } = require('./server/middleware/errors');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS goes BEFORE helmet and the body parsers so the preflight OPTIONS
// requests resolve cleanly without falling through to other middleware that
// might set conflicting headers or return early.
//
// We use a function-style `origin` rather than an array of strings — that
// way the `Vary: Origin` and `Access-Control-Allow-Origin: <exact-origin>`
// headers always reflect the actual request, never the wildcard `*`. The
// browser refuses `*` whenever the request is credentialed (cookies /
// Authorization / withCredentials:true), which is the failure mode we see
// in the seller login flow.
const corsAllowlist = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
app.use(cors({
  origin(origin, callback) {
    // Same-origin / curl / server-to-server (no Origin header) — let through.
    if (!origin) return callback(null, true);
    if (corsAllowlist.includes(origin)) return callback(null, origin);
    // Unknown origin → reject. Browser surfaces this as a CORS error which
    // is what we want — better than silently allowing every site.
    return callback(new Error(`Origin "${origin}" not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
}));

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const publicUploadsDir = path.resolve(__dirname, process.env.UPLOAD_PUBLIC_DIR || 'uploads/public');
app.use('/uploads/public', express.static(publicUploadsDir, { maxAge: '7d', fallthrough: true }));

app.use('/api', apiRouter);

const staticDir = path.resolve(__dirname, 'public');
app.use(express.static(staticDir));

app.get(/^\/(?!api|uploads).*/, (req, res, next) => {
  res.sendFile(path.join(staticDir, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use(notFound);
app.use(errorHandler);

const port = Number(process.env.PORT) || 4000;
if (require.main === module) {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on :${port} (${process.env.NODE_ENV || 'development'})`);
  });
}

module.exports = app;
