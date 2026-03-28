/**
 * @fileoverview Feature usage analytics routes — server-side storage.
 *
 * Endpoints:
 *   GET  /api/feature-usage       — return all usage data
 *   POST /api/feature-usage/track — record a feature usage event
 *   POST /api/feature-usage/reset — clear all usage data
 *
 * Data is stored in ~/.codeman/feature-usage.json as a flat JSON object:
 *   { [featureId]: { count: number, firstUsed: string, lastUsed: string } }
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FastifyInstance } from 'fastify';

const STORAGE_FILE = path.join(os.homedir(), '.codeman', 'feature-usage.json');

interface UsageEntry {
  count: number;
  firstUsed: string;
  lastUsed: string;
}

type UsageData = Record<string, UsageEntry>;

function readUsageData(): UsageData {
  try {
    const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeUsageData(data: UsageData): void {
  const dir = path.dirname(STORAGE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

export function registerFeatureUsageRoutes(app: FastifyInstance): void {
  // GET /api/feature-usage — return all usage data
  app.get('/api/feature-usage', async (_req, reply) => {
    const data = readUsageData();
    return reply.send({ success: true, data });
  });

  // POST /api/feature-usage/track — record a feature usage event
  app.post('/api/feature-usage/track', async (req, reply) => {
    const { featureId, timestamp } = req.body as { featureId?: string; timestamp?: string };
    if (!featureId || typeof featureId !== 'string') {
      return reply.status(400).send({ success: false, error: 'featureId is required' });
    }

    const data = readUsageData();
    const iso = timestamp || new Date().toISOString();
    const existing = data[featureId];

    if (existing) {
      existing.count++;
      existing.lastUsed = iso;
    } else {
      data[featureId] = { count: 1, firstUsed: iso, lastUsed: iso };
    }

    writeUsageData(data);
    return reply.send({ success: true });
  });

  // POST /api/feature-usage/reset — clear all usage data
  app.post('/api/feature-usage/reset', async (_req, reply) => {
    try {
      if (fs.existsSync(STORAGE_FILE)) {
        fs.unlinkSync(STORAGE_FILE);
      }
    } catch {
      // ignore — file may not exist
    }
    return reply.send({ success: true });
  });
}
