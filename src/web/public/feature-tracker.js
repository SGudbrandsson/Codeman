/**
 * FeatureTracker — lightweight usage analytics stored in localStorage.
 * All data stays local; no external services.
 */
window.FeatureTracker = {
  STORAGE_KEY: 'codeman-feature-usage',
  DEBOUNCE_MS: 1000,
  _data: null,       // lazy-loaded from localStorage
  _lastTrack: {},    // { [featureId]: timestamp } for debounce

  _load() {
    if (this._data !== null) return this._data;
    try {
      this._data = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
    } catch (e) {
      this._data = {};
    }
    return this._data;
  },

  _save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._data));
    } catch (e) {
      // localStorage full or unavailable — ignore
    }
  },

  track(featureId) {
    const now = Date.now();
    if (this._lastTrack[featureId] && (now - this._lastTrack[featureId]) < this.DEBOUNCE_MS) return;
    this._lastTrack[featureId] = now;
    const data = this._load();
    const iso = new Date(now).toISOString();
    if (data[featureId]) {
      data[featureId].count++;
      data[featureId].lastUsed = iso;
    } else {
      data[featureId] = { count: 1, firstUsed: iso, lastUsed: iso };
    }
    this._save();
  },

  getData() {
    const data = this._load();
    return Object.assign({}, data);
  },

  reset() {
    this._data = {};
    this._lastTrack = {};
    localStorage.removeItem(this.STORAGE_KEY);
  },

  exportJson() {
    const data = this._load();
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

  _exportAndDownload() {
    const json = this.exportJson();
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

  _resetWithConfirm() {
    if (!confirm('Reset all feature usage data? This cannot be undone.')) return;
    this.reset();
    this._renderTable();
    const sinceEl = document.getElementById('featureUsageTrackingSince');
    if (sinceEl) sinceEl.textContent = '\u2014';
  },

  _renderTable() {
    const container = document.getElementById('featureUsageTable');
    if (!container) return;
    const data = this._load();

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
    const borderColor = count => count === 0 ? '#ef4444' : count <= 3 ? '#f59e0b' : '#22c55e';

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
