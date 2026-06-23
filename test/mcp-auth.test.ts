import { describe, it, expect } from 'vitest';
import { buildAuthHeaders } from '../src/mcp-server.js';

describe('buildAuthHeaders', () => {
  it('returns no auth header when no password is set', () => {
    expect(buildAuthHeaders({})).toEqual({ 'Content-Type': 'application/json' });
  });
  it('adds Basic auth from CODEMAN_PASSWORD with default admin user', () => {
    const h = buildAuthHeaders({ CODEMAN_PASSWORD: 'secret' });
    expect(h.Authorization).toBe('Basic ' + Buffer.from('admin:secret').toString('base64'));
  });
  it('honors CODEMAN_USERNAME', () => {
    const h = buildAuthHeaders({ CODEMAN_USERNAME: 'siggi', CODEMAN_PASSWORD: 'pw' });
    expect(h.Authorization).toBe('Basic ' + Buffer.from('siggi:pw').toString('base64'));
  });
});
