import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import dotenv from 'dotenv';
import morgan from 'morgan';
import { createStream } from 'rotating-file-stream';
import { createApp } from './src/backend/app.js';
import { resolveRuntimeDbPath } from './src/backend/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT;
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const { db, app: apiApp } = await createApp();

  const app = express();

  // Ensure logs directory exists
  const logDirectory = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory, { recursive: true });
  }

  // Filename generator for daily rotation: prefix-dd-mm-yyyy.log
  const createLogFilename = (prefix) => (time, index) => {
    const t = time || new Date();
    const d = String(t.getDate()).padStart(2, '0');
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const y = t.getFullYear();
    const idx = index > 1 ? `-${index}` : '';
    return `${prefix}-${d}-${m}-${y}${idx}.log`;
  };

  // Create daily rotating write streams with GZIP compression
  const accessLogStream = createStream(createLogFilename('access'), {
    interval: '1d', // rotate daily
    size: '100M', // also rotate if file exceeds 100MB
    path: logDirectory,
    compress: 'gzip', // natively gzip archives (~90% compression)
    maxFiles: 14 // standard 2 weeks retention for access logs
  });

  const errorLogStream = createStream(createLogFilename('error'), {
    interval: '1d',
    size: '20M',
    path: logDirectory,
    compress: 'gzip',
    maxFiles: 30 // keep silent errors longer for debugging
  });

  // Use 'short' format to drastically save horizontal log size without losing crucial endpoint info
  app.use(morgan('short', { stream: accessLogStream }));

  // Log only errors (status >= 400) to error stream
  app.use(morgan('short', {
    stream: errorLogStream,
    skip: (req, res) => res.statusCode < 400
  }));

  // Cleaner, colorized format for the immediate console
  app.use(morgan('dev'));

  // Mount the secure API under root (the routers inside already prefix /api)
  app.use('/', apiApp);

  if (!isProduction) {
    // Development mode: use Vite's middleware
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });

    app.use(vite.middlewares);
    console.log('[Worker] Vite development server attached.');
  } else {
    // Production mode: serve static files natively via Express
    const distPath = path.join(__dirname, 'dist');
    if (!fs.existsSync(distPath)) {
      console.warn('[Worker] WARNING: dist directory not found! Run `npm run build` for production.');
    } else {
      app.use(express.static(distPath));
      app.get(/(.*)/, (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
      console.log('[Worker] Static production files served from /dist');
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`[Worker] Orchestrator listening on http://127.0.0.1:${PORT}`);
    console.log(`[Worker] Environment: ${isProduction ? 'Production' : 'Development'}`);
    console.log(`[Worker] SQLite Runtime Path: ${resolveRuntimeDbPath()}`);
  });

  function shutdown(signal) {
    console.log(`\n[Worker] ${signal} received, shutting down...`);
    server.close(() => {
      db.close();
      console.log('[Worker] DB closed. Exiting.');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('[Worker] Force closing...');
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch(err => {
  console.error('[Worker] Fatal error starting server:', err);
  process.exit(1);
});
