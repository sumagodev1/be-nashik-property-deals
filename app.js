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

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : [];
app.use(cors({ origin: corsOrigin.length ? corsOrigin : false, credentials: true }));

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
