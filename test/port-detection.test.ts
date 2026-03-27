/**
 * @fileoverview Tests for port detection and allocation utilities.
 *
 * Covers: extractPortsFromText, isPortFree, allocateNextPort.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { extractPortsFromText, isPortFree, allocateNextPort } from '../src/utils/port-detection.js';

describe('extractPortsFromText', () => {
  it('detects localhost:PORT pattern', () => {
    expect(extractPortsFromText('Visit http://localhost:3000')).toEqual([3000]);
  });

  it('detects 127.0.0.1:PORT pattern', () => {
    expect(extractPortsFromText('Running on 127.0.0.1:8080')).toEqual([8080]);
  });

  it('detects 0.0.0.0:PORT pattern', () => {
    expect(extractPortsFromText('Listening on 0.0.0.0:4000')).toEqual([4000]);
  });

  it('detects --port flag with space', () => {
    expect(extractPortsFromText('npx tsx src/index.ts web --port 3001')).toEqual([3001]);
  });

  it('detects --port flag with equals', () => {
    expect(extractPortsFromText('node server.js --port=8080')).toEqual([8080]);
  });

  it('detects PORT= env var style', () => {
    expect(extractPortsFromText('PORT=5000 node app.js')).toEqual([5000]);
  });

  it('detects PORT: style', () => {
    expect(extractPortsFromText('PORT: 9000')).toEqual([9000]);
  });

  it('detects "port" word followed by number', () => {
    expect(extractPortsFromText('Default port: 3000')).toEqual([3000]);
  });

  it('detects port in markdown backticks', () => {
    expect(extractPortsFromText('Port: `3001`')).toEqual([3001]);
  });

  it('returns multiple ports sorted and deduplicated', () => {
    const text = 'localhost:3000 and localhost:8080 and localhost:3000';
    expect(extractPortsFromText(text)).toEqual([3000, 8080]);
  });

  it('ignores ports below 1024', () => {
    expect(extractPortsFromText('localhost:80')).toEqual([]);
  });

  it('ignores ports above 65535', () => {
    expect(extractPortsFromText('localhost:99999')).toEqual([]);
  });

  it('returns empty array for text with no ports', () => {
    expect(extractPortsFromText('No ports mentioned here')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractPortsFromText('')).toEqual([]);
  });
});

describe('isPortFree', () => {
  let server: net.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('returns true for a free port', async () => {
    // Use port 0 to get an OS-assigned port, then close it and check
    const assignedPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '0.0.0.0', () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.once('error', reject);
    });

    const free = await isPortFree(assignedPort);
    expect(free).toBe(true);
  });

  it('returns false for an occupied port', async () => {
    const assignedPort = await new Promise<number>((resolve, reject) => {
      server = net.createServer();
      server.listen(0, '0.0.0.0', () => {
        const addr = server!.address() as net.AddressInfo;
        resolve(addr.port);
      });
      server.once('error', reject);
    });

    const free = await isPortFree(assignedPort);
    expect(free).toBe(false);
  });
});

describe('allocateNextPort', () => {
  let servers: net.Server[] = [];

  afterEach(async () => {
    for (const srv of servers) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    servers = [];
  });

  /** Bind a server to a specific port and track it for cleanup. */
  async function occupyPort(port: number): Promise<void> {
    const srv = net.createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '0.0.0.0', () => resolve());
    });
    servers.push(srv);
  }

  // Use high ports (49200+) to avoid collisions with real services
  it('returns basePorts max + 1 when no used ports', async () => {
    const result = await allocateNextPort([49200], []);
    expect(result).toBe(49201);
  });

  it('falls back to 3100 base when basePorts is empty', async () => {
    const result = await allocateNextPort([], []);
    // effectiveBase=[3100], start = 3100+1 = 3101
    expect(result).toBe(3101);
  });

  it('skips ports in usedPorts', async () => {
    const result = await allocateNextPort([49200], [49201, 49202]);
    expect(result).toBe(49203);
  });

  it('uses fallback base and skips used ports', async () => {
    const result = await allocateNextPort([], [3101]);
    expect(result).toBe(3102);
  });

  it('skips ports that are occupied on the system', async () => {
    // Occupy 49301 so allocateNextPort must skip it
    await occupyPort(49301);

    const result = await allocateNextPort([49300], []);
    // 49301 is occupied, so it should return 49302
    expect(result).toBe(49302);
  });

  it('skips ports in allKnown set (base ports)', async () => {
    // basePorts=[49400, 49401] — both in allKnown, start = max+1 = 49402
    const result = await allocateNextPort([49400, 49401], []);
    expect(result).toBe(49402);
  });
});
