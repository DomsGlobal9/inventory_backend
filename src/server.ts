import express from 'express'; // Restart trigger 2
import cors from 'cors';
import { env } from './config/env';
import { requestLogger } from './middleware/request-logger';
import { errorHandler } from './middleware/error.middleware';

import { prisma } from './lib/prisma';
import { tenantRateLimiter } from './middleware/rate-limiter.middleware';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';

const app = express();

// Global Middleware
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness Check
app.get('/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ready', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'not_ready' });
  }
});

// Apply rate limiting to all /api routes
app.use('/api', tenantRateLimiter);

import apiRoutes from './routes/api.routes';

// Mount Routes
app.use('/api/v1', apiRoutes);
// Global Error Handler (Must be last)
app.use(errorHandler);

const PORT = env.PORT;

app.listen(PORT, () => {
  console.log(`🚀 Inventory Microservice running on port ${PORT}`);
  WebhookDispatcherService.startPolling();
});
