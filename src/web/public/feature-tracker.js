/**
 * FeatureTracker — lightweight usage analytics with server-side storage.
 * Data is stored on the server at ~/.codeman/feature-usage.json so usage
 * is tracked across all devices.
 */
window.FeatureTracker = {
  DEBOUNCE_MS: 1000,
  _lastTrack: {},    // { [featureId]: timestamp } for client-side debounce

  track(featureId) {
    const now = Date.now();
    if (this._lastTrack[featureId] && (now - this._lastTrack[featureId]) < this.DEBOUNCE_MS) return;
    this._lastTrack[featureId] = now;
    // Fire-and-forget POST — don't block UI
    fetch('/api/feature-usage/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId, timestamp: new Date(now).toISOString() }),
    }).catch(() => { /* silent — analytics should never break the app */ });
  },

  async getData() {
    try {
      const res = await fetch('/api/feature-usage');
      const json = await res.json();
      return json.data || {};
    } catch {
      return {};
    }
  },

  async reset() {
    this._lastTrack = {};
    try {
      await fetch('/api/feature-usage/reset', { method: 'POST' });
    } catch {
      // silent
    }
  },

  async exportJson() {
    const data = await this.getData();
    const rows = (window.FeatureRegistry || []).map(f => ({
      id: f.id,
      name: f.name,
      category: f.category,
      description: f.description,
      count: (data[f.id] || {}).count || 0,
      firstUsed: (data[f.id] || {}).firstUsed || null,
      lastUsed: (data[f.id] || {}).lastUsed || null,
    }));
    return JSON.stringify(rows, null, 2);
  },

  async _exportAndDownload() {
    const json = await this.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'codeman-feature-usage-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  async _resetWithConfirm() {
    if (!confirm('Reset all feature usage data? This cannot be undone.')) return;
    await this.reset();
    await this._renderTable();
    const sinceEl = document.getElementById('featureUsageTrackingSince');
    if (sinceEl) sinceEl.textContent = '\u2014';
  },

  async _renderTable() {
    const container = document.getElementById('featureUsageTable');
    if (!container) return;
    const data = await this.getData();

    // Find earliest firstUsed date
    let earliest = null;
    Object.values(data).forEach(v => {
      if (v.firstUsed && (!earliest || v.firstUsed < earliest)) earliest = v.firstUsed;
    });
    const sinceEl = document.getElementById('featureUsageTrackingSince');
    if (sinceEl) sinceEl.textContent = earliest ? new Date(earliest).toLocaleString() : '\u2014';

    const rows = (window.FeatureRegistry || []).map(f => ({
      ...f,
      count: (data[f.id] || {}).count || 0,
      firstUsed: (data[f.id] || {}).firstUsed || null,
      lastUsed: (data[f.id] || {}).lastUsed || null,
    })).sort((a, b) => a.count - b.count);

    const fmtDate = iso => iso ? new Date(iso).toLocaleString() : '\u2014';
    const borderColor = count => count === 0 ? 'var(--red)' : count <= 3 ? 'var(--yellow)' : 'var(--green)';

    // Build table using DOM methods to avoid innerHTML with external data
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px';

    // Header
    const thead = table.createTHead();
    const hRow = thead.insertRow();
    hRow.style.cssText = 'text-align:left;border-bottom:1px solid var(--border-color,#333)';
    ['Feature', 'Category', 'Count', 'Last Used', 'First Used'].forEach((text, i) => {
      const th = document.createElement('th');
      th.style.padding = '6px 8px';
      if (i === 2) th.style.textAlign = 'right';
      th.textContent = text;
      hRow.appendChild(th);
    });

    // Body
    const tbody = table.createTBody();
    rows.forEach(r => {
      const tr = tbody.insertRow();
      tr.style.cssText = 'border-left:3px solid ' + borderColor(r.count) + ';border-bottom:1px solid var(--border-color,#222)';

      const tdName = tr.insertCell(); tdName.style.padding = '5px 8px'; tdName.textContent = r.name;
      const tdCat  = tr.insertCell(); tdCat.style.cssText  = 'padding:5px 8px;color:var(--text-muted,#888)'; tdCat.textContent = r.category;
      const tdCnt  = tr.insertCell(); tdCnt.style.cssText  = 'padding:5px 8px;text-align:right;font-variant-numeric:tabular-nums'; tdCnt.textContent = String(r.count);
      const tdLast = tr.insertCell(); tdLast.style.cssText = 'padding:5px 8px;color:var(--text-muted,#888)'; tdLast.textContent = fmtDate(r.lastUsed);
      const tdFst  = tr.insertCell(); tdFst.style.cssText  = 'padding:5px 8px;color:var(--text-muted,#888)'; tdFst.textContent  = fmtDate(r.firstUsed);
    });

    container.replaceChildren(table);
  },
};
