(() => {
  'use strict';

  const MUNICIPALITIES = [
    'Alburquerque', 'Alicia', 'Anda', 'Antequera', 'Baclayon', 'Balilihan',
    'Batuan', 'Bien Unido', 'Bilar', 'Buenavista', 'Calape', 'Candijay',
    'Carmen', 'Catigbian', 'Clarin', 'Corella', 'Cortes', 'Dagohoy',
    'Danao', 'Dauis', 'Dimiao', 'Duero', 'Garcia Hernandez', 'Getafe', 'Guindulman',
    'Inabanga', 'Jagna', 'Lila', 'Loay', 'Loboc', 'Loon', 'Mabini',
    'Maribojoc', 'Panglao', 'Pilar', 'President Carlos P. Garcia',
    'Sagbayan', 'San Isidro', 'San Miguel', 'Sevilla', 'Sierra Bullones',
    'Sikatuna', 'Talibon', 'Trinidad', 'Tubigon', 'Ubay', 'Valencia'
  ];
  const MUNICIPALITY_DATA = window.BOHOL_BARANGAYS.municipalities;
  const MUNICIPALITY_DATA_BY_NAME = new Map(MUNICIPALITY_DATA.map((item) => [item.name, item]));
  const BARANGAY_BY_CODE = new Map(MUNICIPALITY_DATA.flatMap((item) =>
    item.barangays.map((barangay) => [barangay.code, { ...barangay, municipality: item.name }])
  ));
  const ALL_BARANGAYS = MUNICIPALITY_DATA.flatMap((item) =>
    item.barangays.map((barangay) => ({ ...barangay, municipality: item.name }))
  );
  const STORAGE_KEY = 'bohol-asf-watch-reports-v1';
  const AUDIT_STORAGE_KEY = 'bohol-asf-watch-audit-v1';
  const RECENT_DAYS = 7;
  const STALE_DAYS = 30;
  const AUDIT_LIMIT = 1000;
  const backendMode = Boolean(window.BOHOL_ASF_BACKEND?.enabled);
  let csrfToken = window.BOHOL_ASF_BACKEND?.csrfToken || '';
  let currentUser = null;
  async function disableBackendOfflineCache() {
    if (!backendMode || !('serviceWorker' in navigator)) return true;
    const registration = await navigator.serviceWorker.getRegistration();
    const isControlled = Boolean(navigator.serviceWorker.controller);
    if (!registration && !isControlled) return true;
    if (registration) await registration.unregister();
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith('bohol-asf-watch-'))
      .map((name) => caches.delete(name)));
    window.location.reload();
    return false;
  }
  const STATUS_CLASS = {
    'No report': 'status-unreported',
    'No suspected cases': 'status-negative',
    'Suspected ASF': 'status-suspected',
    'Confirmed ASF': 'status-confirmed',
    'Under surveillance': 'status-surveillance',
    'Cleared': 'status-cleared'
  };
  const STATUS_LABEL = {
    'No report': 'No report',
    'No suspected cases': 'No suspected cases reported',
    'Suspected ASF': 'Suspected ASF',
    'Confirmed ASF': 'Confirmed ASF',
    'Under surveillance': 'Under surveillance',
    'Cleared': 'Cleared'
  };

  const elements = {
    municipalityRows: document.querySelector('#municipality-rows'),
    reportList: document.querySelector('#report-list'),
    reportDialog: document.querySelector('#report-dialog'),
    reportForm: document.querySelector('#report-form'),
    municipalitySelect: document.querySelector('#report-municipality'),
    barangaySelect: document.querySelector('#report-barangay'),
    reportDate: document.querySelector('#report-date'),
    search: document.querySelector('#municipality-search'),
    emptyResults: document.querySelector('#empty-results'),
    formError: document.querySelector('#form-error'),
    municipalityFilter: document.querySelector('#municipality-filter'),
    dateFrom: document.querySelector('#date-from'),
    dateTo: document.querySelector('#date-to'),
    filterError: document.querySelector('#filter-error'),
    trendChart: document.querySelector('#trend-chart'),
    trendPeriod: document.querySelector('#trend-period'),
    municipalityMap: document.querySelector('#municipality-map'),
    backupStatus: document.querySelector('#report-operation-status'),
    exportSummary: document.querySelector('#export-summary'),
    installApp: document.querySelector('#install-app'),
    offlineStatus: document.querySelector('#offline-status'),
    toggleAllReports: document.querySelector('#toggle-all-reports'),
    demoModeBanner: document.querySelector('#demo-mode-banner'),
    backendStatusBanner: document.querySelector('#backend-status-banner')
  };

  let reports = backendMode ? [] : loadReports();
  let auditLog = backendMode ? [] : loadAuditLog();
  let selectedFilter = 'all';
  let municipalityFilter = '';
  let editingReportId = '';
  let installPrompt = null;
  let showAllReports = false;
  const expandedMunicipalities = new Set();
  const collapsedSearchResults = new Set();

  async function apiRequest(action, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['X-CSRF-Token'] = csrfToken;
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`api.php?action=${encodeURIComponent(action)}${options.query || ''}`, {
      method,
      credentials: 'same-origin',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    let result;
    try {
      result = await response.json();
    } catch (error) {
      console.error('The ASF backend returned an invalid response:', error);
      throw new Error('The server returned an invalid response. Check the PHP server log.');
    }
    if (response.status === 401) {
      window.location.assign('login.php');
      throw new Error('Your session expired. Sign in again.');
    }
    if (!response.ok) {
      throw new Error(typeof result.error === 'string' ? result.error : 'The server request failed.');
    }
    return result;
  }

  function applyBackendState(state) {
    reports = state.reports;
    auditLog = state.auditLog;
    currentUser = state.user;
    csrfToken = state.csrfToken;
    document.body.dataset.backendRole = currentUser.role;
  }

  async function refreshBackendState() {
    const state = await apiRequest('state');
    applyBackendState(state);
  }

  function loadReports() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === null) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) throw new Error('Stored report data is not a list.');
      return parsed.filter((report) =>
        report && typeof report.id === 'string' &&
        MUNICIPALITIES.includes(report.municipality) &&
        (!report.barangayCode ||
          BARANGAY_BY_CODE.get(report.barangayCode)?.municipality === report.municipality) &&
        typeof report.status === 'string' &&
        isValidDateString(report.date)
      );
    } catch (error) {
      console.error('Unable to load saved ASF reports:', error);
      window.setTimeout(() => window.alert('Saved report data could not be read. The dashboard will open without those records. Check browser storage before entering more reports.'), 0);
      return [];
    }
  }

  function loadAuditLog() {
    try {
      const saved = localStorage.getItem(AUDIT_STORAGE_KEY);
      if (saved === null) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) throw new Error('Stored audit data is not a list.');
      return parsed.filter((event) =>
        event && typeof event.id === 'string' &&
        ['created', 'edited', 'deleted', 'restored'].includes(event.action) &&
        typeof event.reportId === 'string' &&
        typeof event.location === 'string' &&
        typeof event.reportDate === 'string' &&
        typeof event.timestamp === 'string'
      ).slice(-AUDIT_LIMIT);
    } catch (error) {
      console.error('Unable to load ASF change history:', error);
      window.setTimeout(() => window.alert('Saved change history could not be read. The dashboard will open without that history. Check browser storage before making changes.'), 0);
      return [];
    }
  }

  function persistState(errorTarget = elements.formError) {
    let previousReports;
    let previousAudit;
    try {
      previousReports = localStorage.getItem(STORAGE_KEY);
      previousAudit = localStorage.getItem(AUDIT_STORAGE_KEY);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
      localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(auditLog.slice(-AUDIT_LIMIT)));
      return true;
    } catch (error) {
      console.error('Unable to save ASF reports and change history:', error);
      try {
        if (previousReports === null) localStorage.removeItem(STORAGE_KEY);
        else if (typeof previousReports === 'string') localStorage.setItem(STORAGE_KEY, previousReports);
        if (previousAudit === null) localStorage.removeItem(AUDIT_STORAGE_KEY);
        else if (typeof previousAudit === 'string') localStorage.setItem(AUDIT_STORAGE_KEY, previousAudit);
      } catch (rollbackError) {
        console.error('Unable to restore the previous ASF data after a failed save:', rollbackError);
      }
      errorTarget.textContent = 'The report and its change history could not be saved in this browser. Check available storage and try again.';
      errorTarget.hidden = false;
      return false;
    }
  }

  function latestReportByBarangay() {
    const latest = new Map();
    for (const report of reports) {
      if (!report.barangayCode) continue;
      const previous = latest.get(report.barangayCode);
      const reportTime = Date.parse(`${report.date}T00:00:00`);
      const previousTime = previous ? Date.parse(`${previous.date}T00:00:00`) : -Infinity;
      const reportUpdatedAt = report.updatedAt || report.createdAt || '';
      const previousUpdatedAt = previous ? previous.updatedAt || previous.createdAt || '' : '';
      if (!previous || reportTime > previousTime ||
        (reportTime === previousTime && reportUpdatedAt > previousUpdatedAt)) {
        latest.set(report.barangayCode, report);
      }
    }
    return latest;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatDate(dateString) {
    if (!dateString) return '—';
    const date = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  function reportLocation(report) {
    const barangayName = report.barangayCode
      ? BARANGAY_BY_CODE.get(report.barangayCode)?.name || 'Unknown barangay'
      : 'Municipality-wide';
    return `${report.municipality} · ${barangayName}`;
  }

  function createId() {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function makeAuditEvent(action, report, changedFields = []) {
    return {
      id: createId(),
      action,
      reportId: report.id,
      location: reportLocation(report),
      reportDate: report.date,
      changedFields,
      timestamp: new Date().toISOString()
    };
  }

  function fieldChanges(previous, next) {
    const labels = {
      municipality: 'Municipality',
      barangayCode: 'Barangay',
      status: 'Status',
      date: 'Report date',
      farms: 'Affected farms',
      pigsAffected: 'Pigs affected',
      pigsDead: 'Pigs dead',
      pigsCulled: 'Pigs culled',
      source: 'Source',
      notes: 'Notes'
    };
    return Object.keys(labels).filter((key) => previous[key] !== next[key]).map((key) => labels[key]);
  }

  function appendAuditEvent(event) {
    auditLog = [...auditLog, event].slice(-AUDIT_LIMIT);
  }

  function isValidDateString(dateString) {
    const match = typeof dateString === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(0, 0, 0, 0);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function todayDateString() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function ageInDays(dateString) {
    const reportTime = Date.parse(`${dateString}T00:00:00`);
    if (Number.isNaN(reportTime)) return Infinity;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.floor((today.getTime() - reportTime) / 86400000);
  }

  function reportMatchesDateRange(report) {
    if (elements.dateFrom.value && report.date < elements.dateFrom.value) return false;
    if (elements.dateTo.value && report.date > elements.dateTo.value) return false;
    return true;
  }

  function renderTrendChart() {
    const monthCount = Number(elements.trendPeriod.value) || 12;
    const today = new Date();
    const firstMonth = new Date(today.getFullYear(), today.getMonth() - monthCount + 1, 1);
    const monthKeys = Array.from({ length: monthCount }, (_, index) => {
      const month = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + index, 1);
      return {
        key: `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`,
        label: new Intl.DateTimeFormat(undefined, { month: 'short' }).format(month)
      };
    });
    const buckets = new Map(monthKeys.map(({ key }) => [key, {
      confirmed: 0, suspected: 0, surveillance: 0, other: 0
    }]));
    for (const report of reports) {
      const bucket = buckets.get(report.date.slice(0, 7));
      if (!bucket) continue;
      if (report.status === 'Confirmed ASF') bucket.confirmed += 1;
      else if (report.status === 'Suspected ASF') bucket.suspected += 1;
      else if (report.status === 'Under surveillance') bucket.surveillance += 1;
      else bucket.other += 1;
    }

    const chartWidth = Math.max(480, monthCount * 58 + 42);
    const chartHeight = 210;
    const plotTop = 16;
    const plotHeight = 145;
    const baseY = plotTop + plotHeight;
    const maximum = Math.max(1, ...Array.from(buckets.values(), (bucket) =>
      bucket.confirmed + bucket.suspected + bucket.surveillance + bucket.other
    ));
    const colors = {
      confirmed: '#bd4d46', suspected: '#d29a37',
      surveillance: '#5684ad', other: '#5f9a75'
    };
    const grid = Array.from({ length: 4 }, (_, index) => {
      const y = plotTop + (plotHeight / 3) * index;
      return `<line x1="30" y1="${y}" x2="${chartWidth - 10}" y2="${y}" stroke="#e8ede9"/>
        <text x="24" y="${y + 3}" text-anchor="end" fill="#849087" font-size="9">${Math.round(maximum * (3 - index) / 3)}</text>`;
    }).join('');
    const bars = monthKeys.map(({ key, label }, index) => {
      const bucket = buckets.get(key);
      const x = 42 + index * ((chartWidth - 58) / monthCount);
      const barWidth = Math.min(27, (chartWidth - 58) / monthCount - 10);
      let y = baseY;
      const segments = ['other', 'surveillance', 'suspected', 'confirmed'].map((status) => {
        const height = bucket[status] / maximum * plotHeight;
        y -= height;
        return height ? `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="${colors[status]}">
          <title>${label}: ${bucket[status]} ${status} reports</title>
        </rect>` : '';
      }).join('');
      const total = bucket.confirmed + bucket.suspected + bucket.surveillance + bucket.other;
      const accessibleLabel = `${label} ${key.slice(0, 4)}: ${total} reports`;
      return `<g aria-label="${escapeHtml(accessibleLabel)}">${segments}
        <text x="${x + barWidth / 2}" y="${baseY + 18}" text-anchor="middle" fill="#758078" font-size="9">${escapeHtml(label)}</text>
      </g>`;
    }).join('');
    const accessibleSummary = monthKeys.map(({ key, label }) => {
      const bucket = buckets.get(key);
      return `${label} ${key.slice(0, 4)}: ${bucket.confirmed} confirmed, ${bucket.suspected} suspected, ${bucket.surveillance} under surveillance, ${bucket.other} other reports`;
    }).join('; ');
    elements.trendChart.innerHTML = `<svg viewBox="0 0 ${chartWidth} ${chartHeight}" aria-hidden="true">
      ${grid}${bars}<line x1="30" y1="${baseY}" x2="${chartWidth - 10}" y2="${baseY}" stroke="#cfd8d1"/>
    </svg>`;
    elements.trendChart.setAttribute('aria-label',
      `Monthly report counts by status for the last ${monthCount} months: ${accessibleSummary}.`);
  }

  function municipalityMapStatus(name, latest) {
    const barangays = MUNICIPALITY_DATA_BY_NAME.get(name).barangays;
    const statuses = barangays
      .map((barangay) => latest.get(barangay.code)?.status)
      .filter(Boolean);
    if (statuses.includes('Confirmed ASF')) return 'confirmed';
    if (statuses.includes('Suspected ASF')) return 'suspected';
    if (statuses.includes('Under surveillance')) return 'surveillance';
    const clearStatuses = statuses.every((status) => status === 'No suspected cases' || status === 'Cleared');
    if (statuses.length === barangays.length && clearStatuses) return 'clear';
    return statuses.length ? 'partial' : 'unreported';
  }

  function renderMunicipalityMap(latest) {
    const mapData = window.BOHOL_MAP_FEATURES;
    const shapes = mapData.features.map((feature) => {
      if (!feature.covered) {
        return `<path class="map-boundary map-outside" d="${feature.path}" fill-rule="evenodd">
          <title>${escapeHtml(feature.name)} — separate local government unit, not included in this dashboard</title>
        </path><text class="map-label map-city-label" x="${feature.labelX + 10}" y="${feature.labelY}">Tagbilaran City</text>`;
      }
      const status = municipalityMapStatus(feature.name, latest);
      const municipality = MUNICIPALITY_DATA_BY_NAME.get(feature.name);
      const affected = municipality.barangays.filter((barangay) => latest.has(barangay.code)).length;
      const statusLabel = {
        confirmed: 'confirmed reported',
        suspected: 'suspected reported',
        surveillance: 'under surveillance reported',
        clear: 'all barangays have a no-suspected-cases or cleared report',
        partial: 'reports are incomplete',
        unreported: 'no reports'
      }[status];
      const label = `${feature.name}: ${statusLabel}; ${affected} of ${municipality.barangays.length} barangays have reports`;
      return `<path class="map-boundary map-${status}" data-map-municipality="${escapeHtml(feature.name)}"
        d="${feature.path}" fill-rule="evenodd" role="button" tabindex="0"
        aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title></path>
        ${feature.label ? `<text class="map-label" x="${feature.labelX}" y="${feature.labelY}">${escapeHtml(feature.label)}</text>` : ''}`;
    }).join('');
    elements.municipalityMap.innerHTML = `<svg viewBox="${escapeHtml(mapData.viewBox)}" role="group" aria-labelledby="municipality-map-svg-title">
      <title id="municipality-map-svg-title">Bohol municipality administrative boundaries. Select a municipality boundary to filter the coverage table.</title>
      <rect class="map-ocean" width="1100" height="680" rx="14"/>
      ${shapes}
      <g class="map-north" aria-hidden="true"><text x="1032" y="43">N</text><path d="M1032 50v25m0-25-6 10m6-10 6 10"/></g>
      <g class="map-scale" aria-hidden="true"><path d="M55 628h66m-66-5v10m33-10v10m33-10v10"/><text x="55" y="618">0</text><text x="121" y="618">10 km</text></g>
    </svg>`;
  }

  function renderDashboard() {
    elements.demoModeBanner.hidden = !reports.some((report) =>
      typeof report.source === 'string' && report.source.startsWith('DEMO DATA - FICTIONAL'));
    const latest = latestReportByBarangay();
    const dateRangeActive = Boolean(elements.dateFrom.value || elements.dateTo.value);
    if (elements.dateFrom.value && elements.dateTo.value && elements.dateFrom.value > elements.dateTo.value) {
      elements.filterError.textContent = 'The start date must be on or before the end date.';
      elements.filterError.hidden = false;
    } else {
      elements.filterError.hidden = true;
    }
    const reportedRecent = ALL_BARANGAYS.filter((barangay) => {
      const report = latest.get(barangay.code);
      return report && ageInDays(report.date) >= 0 && ageInDays(report.date) < RECENT_DAYS;
    }).length;
    const suspected = ALL_BARANGAYS.filter((barangay) => latest.get(barangay.code)?.status === 'Suspected ASF').length;
    const confirmed = ALL_BARANGAYS.filter((barangay) => latest.get(barangay.code)?.status === 'Confirmed ASF').length;
    document.querySelector('#municipality-count').textContent = String(MUNICIPALITIES.length);
    document.querySelector('#reported-count').innerHTML = `${reportedRecent}<span class="metric-denom"> / ${ALL_BARANGAYS.length.toLocaleString()}</span>`;
    document.querySelector('#suspected-count').textContent = String(suspected);
    document.querySelector('#confirmed-count').textContent = String(confirmed);

    const lastSaved = reports.reduce((latestDate, report) => {
      const timestamp = Date.parse(report.createdAt || '');
      return Number.isNaN(timestamp) ? latestDate : Math.max(latestDate, timestamp);
    }, 0);
    document.querySelector('#last-updated').textContent = lastSaved
      ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(lastSaved))
      : 'No reports yet';

    const filterCounts = {
      'filter-all-count': ALL_BARANGAYS.length,
      'filter-unreported-count': 0,
      'filter-suspected-count': 0,
      'filter-confirmed-count': 0,
      'filter-surveillance-count': 0,
      'filter-clear-count': 0,
      'filter-cleared-count': 0,
      'filter-stale-count': 0
    };
    for (const barangay of ALL_BARANGAYS) {
      const report = latest.get(barangay.code);
      const status = report?.status || 'No report';
      if (!report) filterCounts['filter-unreported-count'] += 1;
      if (status === 'Suspected ASF') filterCounts['filter-suspected-count'] += 1;
      if (status === 'Confirmed ASF') filterCounts['filter-confirmed-count'] += 1;
      if (status === 'Under surveillance') filterCounts['filter-surveillance-count'] += 1;
      if (status === 'No suspected cases') filterCounts['filter-clear-count'] += 1;
      if (status === 'Cleared') filterCounts['filter-cleared-count'] += 1;
      if (report && ageInDays(report.date) >= STALE_DAYS) filterCounts['filter-stale-count'] += 1;
    }

    const searchTerm = elements.search.value.trim().toLocaleLowerCase();
    const rows = MUNICIPALITIES.map((name) => {
      const municipality = MUNICIPALITY_DATA_BY_NAME.get(name);
      const barangays = municipality.barangays;
      const barangayReports = barangays.map((barangay) => ({
        ...barangay,
        report: latest.get(barangay.code) || null
      }));
      const unreported = barangayReports.filter((item) => !item.report).length;
      const suspectedCount = barangayReports.filter((item) => item.report?.status === 'Suspected ASF').length;
      const confirmedCount = barangayReports.filter((item) => item.report?.status === 'Confirmed ASF').length;
      const matchingBarangays = searchTerm
        ? barangayReports.filter((item) => item.name.toLocaleLowerCase().includes(searchTerm))
        : barangayReports;
      const municipalityMatches = name.toLocaleLowerCase().includes(searchTerm);
      const matchesStatus = (item) => {
        const report = item.report;
        if (dateRangeActive && (!report || !reportMatchesDateRange(report))) return false;
        if (selectedFilter === 'all') return true;
        if (selectedFilter === 'unreported') return !report;
        if (selectedFilter === 'stale') return Boolean(report && ageInDays(report.date) >= STALE_DAYS);
        return report?.status === selectedFilter;
      };
      const matchingStatusCount = barangayReports.filter(matchesStatus).length;
      const filterMatch = matchingStatusCount > 0;
      const searchMatch = !searchTerm || municipalityMatches || matchingBarangays.length > 0;
      if (!filterMatch || !searchMatch || (municipalityFilter && municipalityFilter !== name)) return '';
      const reportedCount = barangays.length - unreported;
      const latestBarangayDate = barangayReports
        .map((item) => item.report?.date || '')
        .filter(Boolean)
        .sort()
        .pop();
      const latestMunicipalityWideReport = reports
        .filter((report) => report.municipality === name && !report.barangayCode)
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
        .pop();
      const municipalityWideIsLatest = latestMunicipalityWideReport &&
        (!latestBarangayDate || latestMunicipalityWideReport.date > latestBarangayDate);
      const latestDate = municipalityWideIsLatest ? latestMunicipalityWideReport.date : latestBarangayDate;
      const isExpanded = expandedMunicipalities.has(name) ||
        Boolean(searchTerm && !municipalityMatches && matchingBarangays.length && !collapsedSearchResults.has(name));
      const visibleBarangays = barangayReports.filter((item) =>
        (!searchTerm || municipalityMatches || item.name.toLocaleLowerCase().includes(searchTerm)) &&
        matchesStatus(item)
      );
      const detailRows = visibleBarangays.map((item) => {
        const report = item.report;
        const status = report?.status || 'No report';
        const age = report ? ageInDays(report.date) : -1;
        const stale = age >= STALE_DAYS;
        return `<tr>
          <td>${escapeHtml(item.name)}</td>
          <td><span class="status-pill ${STATUS_CLASS[status] || STATUS_CLASS['No report']}">${escapeHtml(STATUS_LABEL[status] || status)}</span>${stale ? `<span class="stale-mark" title="Latest report is ${age} days old; reports older than ${STALE_DAYS - 1} days need an update">Needs update · ${age}d</span>` : ''}</td>
          <td>${report ? `${escapeHtml(formatDate(report.date))}${age >= 0 ? `<span class="coverage-caption">${age === 0 ? 'Today' : `${age} days ago`}</span>` : '<span class="coverage-caption">Future-dated report</span>'}` : '—'}</td>
          <td>${report ? escapeHtml(String(Number(report.farms) || 0)) : '—'}</td>
          <td>${report?.source ? escapeHtml(report.source) : '—'}</td>
          <td><button class="row-action" type="button" data-report-for="${escapeHtml(name)}" data-barangay-code="${escapeHtml(item.code)}">Add report</button></td>
        </tr>`;
      }).join('');

      return `<tr class="municipality-row">
        <td><strong>${escapeHtml(name)}</strong></td>
        <td>${reportedCount} / ${barangays.length}<span class="coverage-caption"> reported · ${unreported} no report</span></td>
        <td>${suspectedCount}</td>
        <td>${confirmedCount}</td>
        <td>${latestDate ? escapeHtml(formatDate(latestDate)) : '—'}${municipalityWideIsLatest ? '<span class="coverage-caption">municipality-wide</span>' : ''}</td>
        <td><button class="row-action" type="button" data-toggle-municipality="${escapeHtml(name)}" aria-expanded="${isExpanded}">${isExpanded ? 'Hide' : 'View'} ${barangays.length} barangays</button></td>
      </tr>${isExpanded ? `<tr class="barangay-detail-row"><td colspan="6">
        <div class="barangay-detail">
          <h3>${escapeHtml(name)} <span>${visibleBarangays.length} of ${barangays.length} barangays</span></h3>
          <div class="table-scroll"><table class="barangay-table">
            <thead><tr><th scope="col">Barangay</th><th scope="col">Latest reported status</th><th scope="col">Latest update</th><th scope="col">Affected farms</th><th scope="col">Reported by</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>${detailRows || '<tr><td colspan="6">No barangays match these filters.</td></tr>'}</tbody>
          </table></div>
        </div>
      </td></tr>` : ''}`;
    }).join('');

    elements.municipalityRows.innerHTML = rows;
    elements.emptyResults.hidden = rows.length > 0;
    for (const [id, count] of Object.entries(filterCounts)) {
      document.getElementById(id).textContent = String(count);
    }
    renderTrendChart();
    renderMunicipalityMap(latest);
    renderReports();
    updateExportSummary();
  }

  function renderReports() {
    const sorted = [...reports].sort((a, b) => {
      const dateOrder = (b.date || '').localeCompare(a.date || '');
      return dateOrder || (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    const visibleReports = showAllReports ? sorted : sorted.slice(0, 8);
    elements.toggleAllReports.hidden = sorted.length <= 8;
    elements.toggleAllReports.textContent = showAllReports
      ? 'Show only the 8 most recent reports'
      : `Show all ${sorted.length} reports`;

    if (sorted.length === 0) {
      elements.reportList.innerHTML = '<p class="no-reports">No reports have been entered on this device yet.</p>';
      return;
    }
    elements.reportList.innerHTML = visibleReports.map((report) => {
      const location = escapeHtml(reportLocation(report));
      const details = [
        `${Number(report.farms) || 0} affected farms`,
        `${Number(report.pigsAffected) || 0} pigs affected`,
        `${Number(report.pigsDead) || 0} dead`,
        `${Number(report.pigsCulled) || 0} culled`
      ].join(' · ');
      const note = report.notes ? ` · ${escapeHtml(report.notes)}` : '';
      return `<article class="report-item">
        <div class="report-marker" aria-hidden="true">↗</div>
        <div class="report-main">
          <p class="report-title">${location} <span class="status-pill ${STATUS_CLASS[report.status] || STATUS_CLASS['No report']}">${escapeHtml(STATUS_LABEL[report.status] || report.status)}</span></p>
          <p class="report-detail">${details} · Source: ${escapeHtml(report.source || 'Not specified')}${note}</p>
        </div>
        <div class="report-meta">${escapeHtml(formatDate(report.date))}
          <div class="report-actions">
            <button type="button" data-edit-report="${escapeHtml(report.id)}">Edit</button>
            <button class="delete-report" type="button" data-delete-report="${escapeHtml(report.id)}">Delete</button>
          </div>
        </div>
      </article>`;
    }).join('');
  }

  function updateBarangayOptions(municipality, selectedCode = '') {
    const data = MUNICIPALITY_DATA_BY_NAME.get(municipality);
    if (!data) {
      elements.barangaySelect.innerHTML = '<option value="">Select a municipality first</option>';
      elements.barangaySelect.disabled = true;
      return;
    }
    elements.barangaySelect.disabled = false;
    elements.barangaySelect.innerHTML = `<option value="">Select a barangay</option>${data.barangays.map((barangay) =>
      `<option value="${escapeHtml(barangay.code)}">${escapeHtml(barangay.name)}</option>`
    ).join('')}`;
    elements.barangaySelect.value = selectedCode;
  }

  function openReportDialog(municipality, barangayCode, reportId = '') {
    elements.reportForm.reset();
    elements.formError.hidden = true;
    editingReportId = reportId;
    const report = reports.find((item) => item.id === reportId);
    document.querySelector('#dialog-title').textContent = report ? 'Edit barangay report' : 'Record a barangay report';
    document.querySelector('#save-report').textContent = report ? 'Save changes' : 'Save report';
    elements.reportDate.value = todayDateString();
    const selectedMunicipality = report?.municipality || municipality;
    const selectedBarangay = report?.barangayCode || barangayCode;
    if (selectedMunicipality && MUNICIPALITIES.includes(selectedMunicipality)) {
      elements.municipalitySelect.value = selectedMunicipality;
      updateBarangayOptions(selectedMunicipality, selectedBarangay);
    } else {
      updateBarangayOptions('');
    }
    if (report) {
      elements.reportForm.elements.namedItem('status').value = report.status;
      elements.reportDate.value = report.date;
      elements.reportForm.elements.namedItem('farms').value = report.farms ?? 0;
      elements.reportForm.elements.namedItem('pigs-affected').value = report.pigsAffected ?? 0;
      elements.reportForm.elements.namedItem('pigs-dead').value = report.pigsDead ?? 0;
      elements.reportForm.elements.namedItem('pigs-culled').value = report.pigsCulled ?? 0;
      elements.reportForm.elements.namedItem('source').value = report.source || '';
      elements.reportForm.elements.namedItem('notes').value = report.notes || '';
    }
    elements.reportDialog.showModal();
  }

  function filterReportsForExport() {
    if (elements.dateFrom.value && elements.dateTo.value && elements.dateFrom.value > elements.dateTo.value) return [];
    const latest = latestReportByBarangay();
    const searchTerm = elements.search.value.trim().toLocaleLowerCase();
    return reports.filter((report) => {
      if (municipalityFilter && report.municipality !== municipalityFilter) return false;
      if (!reportMatchesDateRange(report)) return false;
      if (selectedFilter === 'stale') {
        return Boolean(report.barangayCode && latest.get(report.barangayCode)?.id === report.id &&
          ageInDays(report.date) >= STALE_DAYS);
      }
      if (selectedFilter === 'unreported') return false;
      if (selectedFilter !== 'all' && report.status !== selectedFilter) return false;
      if (searchTerm) {
        const barangayName = report.barangayCode
          ? BARANGAY_BY_CODE.get(report.barangayCode)?.name || ''
          : '';
        if (!report.municipality.toLocaleLowerCase().includes(searchTerm) &&
          !barangayName.toLocaleLowerCase().includes(searchTerm)) return false;
      }
      return true;
    });
  }

  function updateExportSummary() {
    const selected = filterReportsForExport();
    elements.exportSummary.textContent =
      `CSV export will include ${selected.length.toLocaleString()} of ${reports.length.toLocaleString()} saved reports using the current search and coverage filters.`;
  }

  function downloadCsv() {
    const header = ['Municipality', 'Barangay', 'PSGC barangay code', 'Report date', 'Status', 'Affected farms', 'Pigs affected', 'Pigs dead', 'Pigs culled', 'Source', 'Notes'];
    const sorted = filterReportsForExport().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const csvCell = (value) => {
      let text = String(value ?? '');
      if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const content = [header, ...sorted.map((report) => [
      report.municipality,
      report.barangayCode ? BARANGAY_BY_CODE.get(report.barangayCode)?.name : 'Municipality-wide',
      report.barangayCode || '',
      report.date, STATUS_LABEL[report.status] || report.status,
      report.farms, report.pigsAffected, report.pigsDead, report.pigsCulled,
      report.source, report.notes
    ])].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const scope = municipalityFilter ? municipalityFilter.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-') : 'filtered';
    link.download = `bohol-asf-reports-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadJsonBackup() {
    if (backendMode) {
      apiRequest('backup').then((backup) => {
        downloadJsonFile(backup);
        elements.backupStatus.textContent = `Server backup downloaded with ${backup.reports.length} reports.`;
      }).catch((error) => {
        console.error('Unable to download server backup:', error);
        elements.backupStatus.textContent = error instanceof Error ? error.message : 'Backup download failed.';
        elements.backupStatus.classList.add('is-error');
      });
      return;
    }
    const backup = {
      format: 'bohol-asf-watch-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      reports,
      auditLog
    };
    downloadJsonFile(backup);
    elements.backupStatus.textContent = `Backup downloaded with ${reports.length} reports.`;
    elements.backupStatus.classList.remove('is-error');
  }

  function downloadJsonFile(backup) {
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bohol-asf-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function validateBackup(backup) {
    if (!backup || backup.format !== 'bohol-asf-watch-backup' || ![1, 2].includes(backup.version) ||
      !Array.isArray(backup.reports)) {
      throw new Error('This file is not a supported Bohol ASF Watch backup.');
    }
    if (backup.reports.length > 50000) {
      throw new Error('This backup contains too many reports to restore safely.');
    }
    const ids = new Set();
    const restoredReports = backup.reports.map((report, index) => {
      const location = `Report ${index + 1}`;
      if (!report || typeof report.id !== 'string' || !report.id.trim() || report.id.length > 128 || ids.has(report.id) ||
        !MUNICIPALITIES.includes(report.municipality) || typeof report.status !== 'string' ||
        !Object.prototype.hasOwnProperty.call(STATUS_LABEL, report.status) ||
        !isValidDateString(report.date) ||
        (report.barangayCode !== undefined && typeof report.barangayCode !== 'string') ||
        typeof report.source !== 'string' || !report.source.trim() || report.source.length > 100 ||
        (report.notes !== undefined && (typeof report.notes !== 'string' || report.notes.length > 500))) {
        throw new Error(`${location} has missing or invalid required fields.`);
      }
      if (report.barangayCode &&
        BARANGAY_BY_CODE.get(report.barangayCode)?.municipality !== report.municipality) {
        throw new Error(`${location} has a barangay code that does not match its municipality.`);
      }
      const numericFields = ['farms', 'pigsAffected', 'pigsDead', 'pigsCulled'];
      const numbers = {};
      for (const field of numericFields) {
        const value = report[field] ?? 0;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          throw new Error(`${location} has an invalid ${field} value.`);
        }
        numbers[field] = value;
      }
      ids.add(report.id);
      return {
        id: report.id,
        municipality: report.municipality,
        barangayCode: report.barangayCode || '',
        status: report.status,
        date: report.date,
        ...numbers,
        source: report.source.trim(),
        notes: report.notes || '',
        ...(typeof report.createdAt === 'string' && !Number.isNaN(Date.parse(report.createdAt))
          ? { createdAt: report.createdAt } : {}),
        ...(typeof report.updatedAt === 'string' && !Number.isNaN(Date.parse(report.updatedAt))
          ? { updatedAt: report.updatedAt } : {})
      };
    });
    const restoredAudit = backup.version === 2 ? backup.auditLog : [];
    if (!Array.isArray(restoredAudit) || restoredAudit.length > AUDIT_LIMIT) {
      throw new Error('This backup contains an invalid change history.');
    }
    const validAudit = restoredAudit.map((event, index) => {
      if (!event || typeof event.id !== 'string' || typeof event.reportId !== 'string' ||
        !['created', 'edited', 'deleted', 'restored'].includes(event.action) ||
        typeof event.location !== 'string' || !isValidDateString(event.reportDate) ||
        typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp)) ||
        (event.changedFields !== undefined &&
          (!Array.isArray(event.changedFields) ||
            event.changedFields.some((field) => typeof field !== 'string')))) {
        throw new Error(`Change history entry ${index + 1} is invalid.`);
      }
      return {
        id: event.id,
        action: event.action,
        reportId: event.reportId,
        location: event.location,
        reportDate: event.reportDate,
        changedFields: event.changedFields || [],
        timestamp: event.timestamp
      };
    });
    return { reports: restoredReports, auditLog: validAudit };
  }

  async function restoreJsonBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    elements.backupStatus.classList.remove('is-error');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose a backup file smaller than 5 MB.');
      const backup = JSON.parse(await file.text());
      const restored = validateBackup(backup);
      const restoreTarget = backendMode ? 'the shared server database' : 'this browser';
      if (!window.confirm(`Restore ${restored.reports.length} reports and ${restored.auditLog.length} change-history entries from this backup? This replaces the records currently stored in ${restoreTarget}.`)) {
        elements.backupStatus.textContent = 'Restore cancelled; existing reports were not changed.';
        return;
      }
      if (backendMode) {
        const state = await apiRequest('restore', { method: 'POST', body: { backup } });
        applyBackendState(state);
        elements.backupStatus.textContent = `Restored ${reports.length} reports to the shared server database.`;
        renderDashboard();
        return;
      }
      const previous = reports;
      const previousAudit = auditLog;
      reports = restored.reports;
      auditLog = restored.auditLog;
      appendAuditEvent({
        id: createId(),
        action: 'restored',
        reportId: 'backup',
        location: 'Backup file',
        reportDate: todayDateString(),
        changedFields: [`Restored ${reports.length} reports`],
        timestamp: new Date().toISOString()
      });
      if (!persistState(elements.backupStatus)) {
        reports = previous;
        auditLog = previousAudit;
        throw new Error('The restored data could not be saved in this browser. Existing reports were kept.');
      }
      elements.backupStatus.textContent = `Restored ${reports.length} reports and ${auditLog.length} change-history entries.`;
      renderDashboard();
    } catch (error) {
      console.error('Unable to restore ASF report backup:', error);
      elements.backupStatus.textContent = error instanceof Error ? error.message : 'The backup could not be restored.';
      elements.backupStatus.classList.add('is-error');
    } finally {
      elements.backupFile.value = '';
    }
  }

  async function loadDemoData() {
    elements.backupStatus.classList.remove('is-error');
    try {
      const restored = validateBackup(window.BOHOL_ASF_DEMO_BACKUP);
      const demoTarget = backendMode ? 'the shared server database' : 'this browser';
      if (!window.confirm(`Load ${restored.reports.length} fictional demo reports? This will replace all reports and change history currently stored in ${demoTarget}. The dashboard will clearly mark the data as fictional.`)) {
        elements.backupStatus.textContent = 'Demo data was not loaded; existing reports were not changed.';
        return;
      }
      if (backendMode) {
        const state = await apiRequest('restore', {
          method: 'POST',
          body: { backup: window.BOHOL_ASF_DEMO_BACKUP }
        });
        applyBackendState(state);
        elements.backupStatus.textContent = `Loaded ${reports.length} fictional demo reports to the shared server.`;
        renderDashboard();
        elements.demoModeBanner.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const previousReports = reports;
      const previousAudit = auditLog;
      reports = restored.reports;
      auditLog = restored.auditLog;
      appendAuditEvent({
        id: createId(),
        action: 'restored',
        reportId: 'demo-backup',
        location: 'Fictional demo data',
        reportDate: todayDateString(),
        changedFields: [`Loaded ${reports.length} fictional demo reports`],
        timestamp: new Date().toISOString()
      });
      if (!persistState(elements.backupStatus)) {
        reports = previousReports;
        auditLog = previousAudit;
        throw new Error('Demo data could not be saved in this browser. Existing reports were kept.');
      }
      elements.backupStatus.textContent = `Loaded ${reports.length} fictional demo reports. This data is not official surveillance.`;
      renderDashboard();
      elements.demoModeBanner.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      console.error('Unable to load fictional ASF demo data:', error);
      elements.backupStatus.textContent = error instanceof Error
        ? error.message
        : 'The fictional demo data could not be loaded.';
      elements.backupStatus.classList.add('is-error');
    }
  }

  async function saveReport(event) {
    event.preventDefault();
    const data = new FormData(elements.reportForm);
    const previousReport = reports.find((item) => item.id === editingReportId);
    const report = {
      id: previousReport?.id || createId(),
      municipality: String(data.get('municipality') || ''),
      barangayCode: String(data.get('barangayCode') || ''),
      status: String(data.get('status') || ''),
      date: String(data.get('date') || ''),
      farms: Number(data.get('farms') || 0),
      pigsAffected: Number(data.get('pigs-affected') || 0),
      pigsDead: Number(data.get('pigs-dead') || 0),
      pigsCulled: Number(data.get('pigs-culled') || 0),
      source: String(data.get('source') || '').trim(),
      notes: String(data.get('notes') || '').trim(),
      createdAt: previousReport?.createdAt || new Date().toISOString(),
      ...(previousReport ? { updatedAt: new Date().toISOString() } : {})
    };
    const barangay = BARANGAY_BY_CODE.get(report.barangayCode);
    const numericValues = [report.farms, report.pigsAffected, report.pigsDead, report.pigsCulled];
    if (!MUNICIPALITIES.includes(report.municipality) ||
      !Object.prototype.hasOwnProperty.call(STATUS_LABEL, report.status) ||
      !barangay || barangay.municipality !== report.municipality ||
      !isValidDateString(report.date) || !report.source || report.source.length > 100 ||
      report.notes.length > 500 ||
      numericValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      elements.formError.textContent = 'Complete all required fields with a valid municipality, barangay, status, date, and source.';
      elements.formError.hidden = false;
      return;
    }
    const duplicate = reports.find((item) => item.id !== report.id &&
      item.barangayCode === report.barangayCode && item.date === report.date);
    if (duplicate && !window.confirm(
      `A report already exists for ${reportLocation(report)} on ${formatDate(report.date)} (${STATUS_LABEL[duplicate.status] || duplicate.status}). Save another report for the same date anyway?`
    )) return;

    const qualityWarnings = [];
    const todayString = todayDateString();
    if (report.date > todayString) qualityWarnings.push('The report date is in the future.');
    if (report.farms > 1000) qualityWarnings.push('The affected-farm count is unusually high (over 1,000).');
    if (report.pigsAffected > 10000) qualityWarnings.push('The pigs-affected count is unusually high (over 10,000).');
    if (report.pigsDead > report.pigsAffected || report.pigsCulled > report.pigsAffected ||
      report.pigsDead + report.pigsCulled > report.pigsAffected) {
      qualityWarnings.push('The dead and culled counts exceed the total pigs affected.');
    }
    if (qualityWarnings.length && !window.confirm(
      `Please review these data-quality warnings:\n\n${qualityWarnings.map((warning) => `• ${warning}`).join('\n')}\n\nSave this report anyway?`
    )) return;

    if (backendMode) {
      try {
        const state = await apiRequest('report', { method: 'POST', body: { report } });
        applyBackendState(state);
        elements.reportDialog.close();
        editingReportId = '';
        renderDashboard();
      } catch (error) {
        console.error('Unable to save ASF report to the shared server:', error);
        elements.formError.textContent = error instanceof Error ? error.message : 'The report could not be saved to the server.';
        elements.formError.hidden = false;
      }
      return;
    }

    const previousReports = reports;
    const previousAudit = auditLog;
    if (previousReport) {
      const changedFields = fieldChanges(previousReport, report);
      if (!changedFields.length) {
        elements.reportDialog.close();
        editingReportId = '';
        return;
      }
      reports = reports.map((item) => item.id === report.id ? report : item);
      appendAuditEvent(makeAuditEvent('edited', report, changedFields));
    } else {
      reports = [...reports, report];
      appendAuditEvent(makeAuditEvent('created', report));
    }
    if (!persistState()) {
      reports = previousReports;
      auditLog = previousAudit;
      return;
    }
    elements.reportDialog.close();
    editingReportId = '';
    renderDashboard();
  }

  async function removeReport(reportId) {
    const report = reports.find((item) => item.id === reportId);
    if (!report) return;
    const location = reportLocation(report);
    if (!window.confirm(`Delete the ${location} report dated ${formatDate(report.date)} from this browser? This action will be recorded in the change log.`)) return;
    if (backendMode) {
      try {
        const state = await apiRequest('report', {
          method: 'DELETE',
          query: `&id=${encodeURIComponent(reportId)}`
        });
        applyBackendState(state);
        renderDashboard();
      } catch (error) {
        console.error('Unable to delete ASF report from the shared server:', error);
        elements.backupStatus.textContent = error instanceof Error ? error.message : 'The report could not be deleted.';
        elements.backupStatus.classList.add('is-error');
      }
      return;
    }
    const previousReports = reports;
    const previousAudit = auditLog;
    reports = reports.filter((item) => item.id !== reportId);
    appendAuditEvent(makeAuditEvent('deleted', report));
    if (!persistState()) {
      reports = previousReports;
      auditLog = previousAudit;
      return;
    }
    renderDashboard();
  }

  async function initialize() {
    const directoryMunicipalities = new Set(MUNICIPALITY_DATA.map((item) => item.name));
    const mappedMunicipalities = new Set(
      (window.BOHOL_MAP_FEATURES?.features || [])
        .filter((feature) => feature.covered)
        .map((feature) => feature.name)
    );
    if (MUNICIPALITY_DATA.length !== MUNICIPALITIES.length ||
      MUNICIPALITIES.some((name) => !directoryMunicipalities.has(name)) ||
      ALL_BARANGAYS.length !== 1094 || BARANGAY_BY_CODE.size !== ALL_BARANGAYS.length ||
      mappedMunicipalities.size !== MUNICIPALITIES.length ||
      MUNICIPALITIES.some((name) => !mappedMunicipalities.has(name)) ||
      !window.BOHOL_MAP_FEATURES.features.some((feature) =>
        feature.name === 'Tagbilaran City' && !feature.covered)) {
      throw new Error('Bohol directory or municipality boundary map failed validation.');
    }
    document.querySelector('#municipality-count').textContent = String(MUNICIPALITIES.length);
    elements.municipalitySelect.innerHTML = `<option value="">Select a municipality</option>${MUNICIPALITIES.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
    elements.municipalityFilter.innerHTML = `<option value="">All municipalities</option>${MUNICIPALITIES.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
    document.querySelectorAll('.filter-chip').forEach((button) => {
      button.addEventListener('click', () => {
        selectedFilter = button.dataset.filter;
        document.querySelectorAll('.filter-chip').forEach((chip) => {
          const selected = chip === button;
          chip.classList.toggle('is-selected', selected);
          chip.setAttribute('aria-pressed', String(selected));
        });
        renderDashboard();
      });
    });
    elements.search.addEventListener('input', () => {
      collapsedSearchResults.clear();
      renderDashboard();
    });
    elements.municipalityFilter.addEventListener('change', () => {
      municipalityFilter = elements.municipalityFilter.value;
      renderDashboard();
    });
    elements.dateFrom.addEventListener('change', renderDashboard);
    elements.dateTo.addEventListener('change', renderDashboard);
    document.querySelector('#clear-filters').addEventListener('click', () => {
      selectedFilter = 'all';
      municipalityFilter = '';
      elements.municipalityFilter.value = '';
      elements.dateFrom.value = '';
      elements.dateTo.value = '';
      elements.search.value = '';
      collapsedSearchResults.clear();
      document.querySelectorAll('.filter-chip').forEach((chip) => {
        const selected = chip.dataset.filter === 'all';
        chip.classList.toggle('is-selected', selected);
        chip.setAttribute('aria-pressed', String(selected));
      });
      renderDashboard();
    });
    elements.trendPeriod.addEventListener('change', renderTrendChart);
    elements.municipalitySelect.addEventListener('change', () => updateBarangayOptions(elements.municipalitySelect.value));
    document.querySelector('#open-report').addEventListener('click', () => openReportDialog());
    document.querySelector('#close-dialog').addEventListener('click', () => elements.reportDialog.close());
    document.querySelector('#cancel-dialog').addEventListener('click', () => elements.reportDialog.close());
    document.querySelector('#export-reports').addEventListener('click', downloadCsv);
    document.querySelector('#print-summary').addEventListener('click', () => window.print());
    elements.reportForm.addEventListener('submit', saveReport);
    elements.municipalityRows.addEventListener('click', (event) => {
      const expandButton = event.target.closest('[data-toggle-municipality]');
      if (expandButton) {
        const municipality = expandButton.dataset.toggleMunicipality;
        if (expandButton.getAttribute('aria-expanded') === 'true') {
          expandedMunicipalities.delete(municipality);
          if (elements.search.value.trim() &&
            !municipality.toLocaleLowerCase().includes(elements.search.value.trim().toLocaleLowerCase())) {
            collapsedSearchResults.add(municipality);
          }
        } else {
          expandedMunicipalities.add(municipality);
          collapsedSearchResults.delete(municipality);
        }
        renderDashboard();
        return;
      }
      const button = event.target.closest('[data-report-for]');
      if (button) openReportDialog(button.dataset.reportFor, button.dataset.barangayCode);
    });
    const activateMapMarker = (event) => {
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      const marker = event.target.closest('[data-map-municipality]');
      if (!marker) return;
      if (event.type === 'keydown') event.preventDefault();
      municipalityFilter = marker.dataset.mapMunicipality;
      elements.municipalityFilter.value = municipalityFilter;
      renderDashboard();
      document.querySelector('.coverage-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    elements.municipalityMap.addEventListener('click', activateMapMarker);
    elements.municipalityMap.addEventListener('keydown', activateMapMarker);
    elements.reportList.addEventListener('click', (event) => {
      const editButton = event.target.closest('[data-edit-report]');
      if (editButton) {
        openReportDialog('', '', editButton.dataset.editReport);
        return;
      }
      const button = event.target.closest('[data-delete-report]');
      if (button) removeReport(button.dataset.deleteReport);
    });
    elements.toggleAllReports.addEventListener('click', () => {
      showAllReports = !showAllReports;
      renderReports();
    });
    if (!backendMode && 'serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
      elements.offlineStatus.textContent = '· Enabling offline support…';
      const registrationTimeout = window.setTimeout(() => {
        elements.offlineStatus.textContent = '· Offline support timed out; check the HTTPS or localhost setup';
      }, 10000);
      navigator.serviceWorker.register('./service-worker.js')
        .then((registration) => {
          const worker = registration.active?.state === 'activated'
            ? registration.active
            : registration.installing || registration.waiting || registration.active;
          if (!worker) {
            window.clearTimeout(registrationTimeout);
            elements.offlineStatus.textContent = '· Offline support registered';
            return;
          }
          const updateStatus = () => {
            if (worker.state === 'activated') {
              window.clearTimeout(registrationTimeout);
              elements.offlineStatus.textContent = '· Offline-ready';
            } else if (worker.state === 'redundant') {
              window.clearTimeout(registrationTimeout);
              elements.offlineStatus.textContent = '· Offline support could not be enabled';
            }
          };
          worker.addEventListener('statechange', updateStatus);
          updateStatus();
        })
        .catch((error) => {
          window.clearTimeout(registrationTimeout);
          console.error('Unable to register the offline app worker:', error);
          elements.offlineStatus.textContent = '· Offline support could not be enabled';
        });
    } else if (!backendMode) {
      elements.offlineStatus.textContent = '· Install/offline mode requires HTTPS or localhost';
    }
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      installPrompt = event;
      elements.installApp.hidden = false;
    });
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      elements.installApp.hidden = true;
      elements.offlineStatus.textContent = '· Installed for offline use';
    });
    elements.installApp.addEventListener('click', async () => {
      if (!installPrompt) return;
      try {
        await installPrompt.prompt();
      } catch (error) {
        console.error('Unable to show the app installation prompt:', error);
        elements.offlineStatus.textContent = '· App installation could not be started';
      } finally {
        installPrompt = null;
        elements.installApp.hidden = true;
      }
    });
    if (backendMode) {
      try {
        if (!(await disableBackendOfflineCache())) return;
        await refreshBackendState();
        elements.offlineStatus.textContent = '· Shared server database';
      } catch (error) {
        console.error('Unable to load shared ASF dashboard data:', error);
        const detail = error instanceof Error ? error.message : 'Shared server data could not be loaded.';
        elements.backendStatusBanner.textContent = `Server data is unavailable. Dashboard values are not loaded; do not treat displayed zeros as reports. Refresh the page to try again. Details: ${detail}`;
        elements.backendStatusBanner.hidden = false;
        elements.backupStatus.textContent = detail;
        elements.backupStatus.classList.add('is-error');
      }
    }
    renderDashboard();
  }

  initialize();
})();
