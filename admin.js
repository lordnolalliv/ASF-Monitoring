(() => {
  'use strict';

  const REPORTS_KEY = 'bohol-asf-watch-reports-v1';
  const AUDIT_KEY = 'bohol-asf-watch-audit-v1';
  const backendMode = Boolean(window.BOHOL_ASF_BACKEND?.enabled);
  let csrfToken = window.BOHOL_ASF_BACKEND?.csrfToken || '';
  let currentUser = null;
  let reports = [];
  let auditLog = [];

  const ui = {
    identity: document.querySelector('#admin-identity'),
    logout: document.querySelector('#admin-logout'),
    logoutCsrf: document.querySelector('#admin-logout-csrf'),
    notice: document.querySelector('#admin-mode-notice'),
    backendError: document.querySelector('#admin-backend-error'),
    badge: document.querySelector('#admin-mode-badge'),
    reportCount: document.querySelector('#admin-report-count'),
    municipalityCount: document.querySelector('#admin-municipality-count'),
    auditCount: document.querySelector('#admin-audit-count'),
    latestDate: document.querySelector('#admin-latest-date'),
    backupFile: document.querySelector('#admin-backup-file'),
    dataStatus: document.querySelector('#admin-data-status'),
    accounts: document.querySelector('#account-management'),
    userForm: document.querySelector('#admin-user-form'),
    usersList: document.querySelector('#admin-users-list'),
    usersStatus: document.querySelector('#admin-users-status'),
    auditList: document.querySelector('#audit-list'),
    auditCountLabel: document.querySelector('#audit-count')
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatDate(value) {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime())
      ? '—'
      : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  function isValidDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

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
      console.error('The admin API returned an invalid response:', error);
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

  function readLocalList(key, label) {
    const saved = localStorage.getItem(key);
    if (saved === null) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) throw new Error(`Saved ${label} must be a list.`);
    return parsed;
  }

  function normalizeBackup(backup) {
    if (!backup || backup.format !== 'bohol-asf-watch-backup' ||
      ![1, 2].includes(backup.version) || !Array.isArray(backup.reports) ||
      backup.reports.length > 50000) {
      throw new Error('This file is not a supported Bohol ASF Watch backup.');
    }
    const ids = new Set();
    const municipalityMap = new Map(
      (window.BOHOL_BARANGAYS?.municipalities || []).map((item) => [item.name, item])
    );
    const statuses = new Set([
      'No suspected cases', 'Suspected ASF', 'Confirmed ASF', 'Under surveillance', 'Cleared'
    ]);
    const cleanReports = backup.reports.map((report, index) => {
      if (!report || typeof report.id !== 'string' || !report.id.trim() ||
        report.id.length > 128 || ids.has(report.id) ||
        typeof report.municipality !== 'string' || !municipalityMap.has(report.municipality) ||
        typeof report.status !== 'string' || !statuses.has(report.status) || !isValidDate(report.date) ||
        (report.barangayCode !== undefined && typeof report.barangayCode !== 'string') ||
        typeof report.source !== 'string' || !report.source.trim() || report.source.length > 100 ||
        (report.notes !== undefined && (typeof report.notes !== 'string' || report.notes.length > 500))) {
        throw new Error(`Report ${index + 1} has invalid or missing fields.`);
      }
      for (const field of ['farms', 'pigsAffected', 'pigsDead', 'pigsCulled']) {
        const value = report[field] ?? 0;
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(`Report ${index + 1} has an invalid ${field} count.`);
        }
      }
      if (report.barangayCode &&
        !municipalityMap.get(report.municipality).barangays.some((barangay) => barangay.code === report.barangayCode)) {
        throw new Error(`Report ${index + 1} has a barangay code that does not match its municipality.`);
      }
      if ((report.pigsDead || 0) + (report.pigsCulled || 0) > (report.pigsAffected || 0)) {
        throw new Error(`Report ${index + 1} has dead and culled counts above pigs affected.`);
      }
      ids.add(report.id);
      return report;
    });
    const sourceAudit = backup.version === 2 ? backup.auditLog : [];
    if (!Array.isArray(sourceAudit) || sourceAudit.length > 1000) {
      throw new Error('This backup contains an invalid change history.');
    }
    const cleanAudit = sourceAudit.map((entry, index) => {
      if (!entry || typeof entry.id !== 'string' || typeof entry.reportId !== 'string' ||
        !['created', 'edited', 'deleted', 'restored'].includes(entry.action) ||
        typeof entry.location !== 'string' || !isValidDate(entry.reportDate) ||
        typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp)) ||
        (entry.changedFields !== undefined &&
          (!Array.isArray(entry.changedFields) || entry.changedFields.some((field) => typeof field !== 'string')))) {
        throw new Error(`Change history entry ${index + 1} is invalid.`);
      }
      return entry;
    });
    return { reports: cleanReports, auditLog: cleanAudit };
  }

  function applyState(state) {
    reports = state.reports;
    auditLog = state.auditLog;
    currentUser = state.user;
    csrfToken = state.csrfToken;
  }

  function renderSummary() {
    ui.reportCount.textContent = reports.length.toLocaleString();
    ui.municipalityCount.textContent = new Set(reports.map((report) => report.municipality)).size.toLocaleString();
    ui.auditCount.textContent = auditLog.length.toLocaleString();
    const latest = reports.reduce((date, report) => report.date > date ? report.date : date, '');
    ui.latestDate.textContent = latest ? formatDate(latest) : '—';
    ui.auditCountLabel.textContent = `${auditLog.length} ${auditLog.length === 1 ? 'event' : 'events'}`;
    if (!auditLog.length) {
      ui.auditList.innerHTML = '<p class="no-reports">No report changes have been recorded yet.</p>';
      return;
    }
    ui.auditList.innerHTML = [...auditLog].reverse().slice(0, 30).map((entry) => {
      const labels = {
        created: 'Report added',
        edited: 'Report edited',
        deleted: 'Report deleted',
        restored: 'Backup restored'
      };
      const time = new Date(entry.timestamp);
      const when = Number.isNaN(time.getTime())
        ? 'Unknown time'
        : new Intl.DateTimeFormat(undefined, {
          year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        }).format(time);
      const changed = entry.changedFields?.length
        ? ` · Changed: ${entry.changedFields.map(escapeHtml).join(', ')}`
        : '';
      const actor = entry.actor ? ` · By ${escapeHtml(entry.actor)}` : '';
      return `<article class="audit-item">
        <span class="audit-marker audit-${escapeHtml(entry.action)}" aria-hidden="true"></span>
        <div><strong>${labels[entry.action] || 'Report changed'}</strong>
          <span>${escapeHtml(entry.location)} · ${escapeHtml(formatDate(entry.reportDate))}${actor}${changed}</span></div>
        <time datetime="${escapeHtml(entry.timestamp)}">${escapeHtml(when)}</time>
      </article>`;
    }).join('');
  }

  function renderUsers(users) {
    ui.usersList.innerHTML = users.map((user) => {
      const options = ['admin', 'editor', 'viewer'].map((role) =>
        `<option value="${role}"${user.role === role ? ' selected' : ''}>${role[0].toUpperCase()}${role.slice(1)}</option>`
      ).join('');
      const created = user.createdAt ? formatDate(user.createdAt.slice(0, 10)) : '—';
      const action = user.id === currentUser.id
        ? '<span class="current-account">Current account</span>'
        : `<button class="account-remove" type="button" data-remove-user="${escapeHtml(user.id)}">Remove</button>`;
      return `<tr><td>${escapeHtml(user.username)}</td>
        <td><select class="account-role-select" data-user-role="${escapeHtml(user.id)}" aria-label="Role for ${escapeHtml(user.username)}">${options}</select></td>
        <td>${escapeHtml(created)}</td><td>${action}</td></tr>`;
    }).join('');
  }

  async function loadUsers() {
    const result = await apiRequest('users');
    renderUsers(result.users);
  }

  function setStatus(target, message, isError = false) {
    target.textContent = message;
    target.classList.toggle('is-error', isError);
  }

  function downloadFile(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadBackup() {
    try {
      const backup = backendMode
        ? await apiRequest('backup')
        : {
          format: 'bohol-asf-watch-backup',
          version: 2,
          exportedAt: new Date().toISOString(),
          reports,
          auditLog
        };
      downloadFile(
        `bohol-asf-backup-${new Date().toISOString().slice(0, 10)}.json`,
        `${JSON.stringify(backup, null, 2)}\n`,
        'application/json;charset=utf-8'
      );
      setStatus(ui.dataStatus, `Backup downloaded with ${backup.reports.length.toLocaleString()} reports.`);
    } catch (error) {
      console.error('Unable to download ASF backup:', error);
      setStatus(ui.dataStatus, error instanceof Error ? error.message : 'Backup download failed.', true);
    }
  }

  function saveLocalState(nextReports, nextAudit) {
    const oldReports = localStorage.getItem(REPORTS_KEY);
    const oldAudit = localStorage.getItem(AUDIT_KEY);
    try {
      localStorage.setItem(REPORTS_KEY, JSON.stringify(nextReports));
      localStorage.setItem(AUDIT_KEY, JSON.stringify(nextAudit.slice(-1000)));
    } catch (error) {
      try {
        if (oldReports === null) localStorage.removeItem(REPORTS_KEY);
        else localStorage.setItem(REPORTS_KEY, oldReports);
        if (oldAudit === null) localStorage.removeItem(AUDIT_KEY);
        else localStorage.setItem(AUDIT_KEY, oldAudit);
      } catch (rollbackError) {
        console.error('Unable to restore prior browser records after failed admin update:', rollbackError);
      }
      throw error;
    }
  }

  async function restoreBackup(backup, label) {
    const normalized = normalizeBackup(backup);
    if (!window.confirm(`Restore ${normalized.reports.length} reports and ${normalized.auditLog.length} history entries from ${label}? This replaces the records in ${backendMode ? 'the shared server database' : 'this browser'}.`)) {
      setStatus(ui.dataStatus, 'Restore cancelled; existing records were not changed.');
      return false;
    }
    if (backendMode) {
      const state = await apiRequest('restore', { method: 'POST', body: { backup } });
      applyState(state);
    } else {
      const audit = [...normalized.auditLog, {
        id: `restore-${Date.now()}`,
        action: 'restored',
        reportId: 'backup',
        location: 'Backup file',
        reportDate: new Date().toISOString().slice(0, 10),
        changedFields: [`Restored ${normalized.reports.length} reports`],
        timestamp: new Date().toISOString()
      }];
      saveLocalState(normalized.reports, audit);
      reports = normalized.reports;
      auditLog = audit.slice(-1000);
    }
    renderSummary();
    setStatus(ui.dataStatus, `Restored ${reports.length.toLocaleString()} reports to ${backendMode ? 'the shared server database' : 'this browser'}.`);
    return true;
  }

  async function handleBackupFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose a backup file smaller than 5 MB.');
      await restoreBackup(JSON.parse(await file.text()), file.name);
    } catch (error) {
      console.error('Unable to restore ASF backup:', error);
      setStatus(ui.dataStatus, error instanceof Error ? error.message : 'Backup restore failed.', true);
    } finally {
      ui.backupFile.value = '';
    }
  }

  async function loadDemo() {
    try {
      const backup = window.BOHOL_ASF_DEMO_BACKUP;
      normalizeBackup(backup);
      if (await restoreBackup(backup, 'the fictional demo backup')) {
        setStatus(ui.dataStatus, `Loaded ${reports.length.toLocaleString()} fictional reports. This is not official ASF surveillance.`);
      }
    } catch (error) {
      console.error('Unable to load ASF demo data:', error);
      setStatus(ui.dataStatus, error instanceof Error ? error.message : 'Demo data could not be loaded.', true);
    }
  }

  function exportCsv() {
    const csvCell = (value) => {
      let text = String(value ?? '');
      if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = ['Municipality', 'Barangay code', 'Report date', 'Status', 'Affected farms', 'Pigs affected', 'Pigs dead', 'Pigs culled', 'Source', 'Notes'];
    const rows = [...reports].sort((a, b) => b.date.localeCompare(a.date)).map((report) => [
      report.municipality, report.barangayCode, report.date, report.status,
      report.farms, report.pigsAffected, report.pigsDead, report.pigsCulled, report.source, report.notes
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    downloadFile(`bohol-asf-reports-${new Date().toISOString().slice(0, 10)}.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
    setStatus(ui.dataStatus, `Exported ${reports.length.toLocaleString()} reports to CSV.`);
  }

  function wireAccounts() {
    ui.userForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setStatus(ui.usersStatus, '');
      const values = new FormData(ui.userForm);
      try {
        await apiRequest('users', {
          method: 'POST',
          body: {
            username: String(values.get('username') || '').trim(),
            password: String(values.get('password') || ''),
            role: String(values.get('role') || '')
          }
        });
        ui.userForm.reset();
        await loadUsers();
        setStatus(ui.usersStatus, 'Account created.');
      } catch (error) {
        console.error('Unable to create ASF dashboard account:', error);
        setStatus(ui.usersStatus, error instanceof Error ? error.message : 'Account creation failed.', true);
      }
    });
    ui.usersList.addEventListener('change', async (event) => {
      const select = event.target.closest('[data-user-role]');
      if (!select) return;
      try {
        const result = await apiRequest('users', {
          method: 'PUT',
          body: { id: select.dataset.userRole, role: select.value }
        });
        renderUsers(result.users);
        setStatus(ui.usersStatus, 'Account role updated.');
      } catch (error) {
        console.error('Unable to update ASF account role:', error);
        setStatus(ui.usersStatus, error instanceof Error ? error.message : 'Account role update failed.', true);
        await loadUsers();
      }
    });
    ui.usersList.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-remove-user]');
      if (!button || !window.confirm('Remove this account? The user will no longer be able to sign in.')) return;
      try {
        const result = await apiRequest('users', {
          method: 'DELETE',
          query: `&id=${encodeURIComponent(button.dataset.removeUser)}`
        });
        renderUsers(result.users);
        setStatus(ui.usersStatus, 'Account removed.');
      } catch (error) {
        console.error('Unable to remove ASF dashboard account:', error);
        setStatus(ui.usersStatus, error instanceof Error ? error.message : 'Account removal failed.', true);
      }
    });
  }

  async function clearBackendOfflineCache() {
    if (!backendMode || !('serviceWorker' in navigator)) return true;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration && !navigator.serviceWorker.controller) return true;
    if (registration) await registration.unregister();
    const cachesToClear = await caches.keys();
    await Promise.all(cachesToClear
      .filter((name) => name.startsWith('bohol-asf-watch-'))
      .map((name) => caches.delete(name)));
    window.location.reload();
    return false;
  }

  async function initialize() {
    document.querySelector('#admin-backup-data').addEventListener('click', downloadBackup);
    document.querySelector('#admin-restore-backup').addEventListener('click', () => ui.backupFile.click());
    document.querySelector('#admin-export-reports').addEventListener('click', exportCsv);
    document.querySelector('#admin-load-demo').addEventListener('click', loadDemo);
    ui.backupFile.addEventListener('change', handleBackupFile);
    ui.accounts.hidden = !backendMode;
    document.querySelector('#accounts-nav').hidden = !backendMode;
    if (!backendMode) {
      ui.identity.textContent = 'Local browser mode';
      ui.badge.textContent = 'Local data';
      ui.badge.classList.add('is-local');
      reports = readLocalList(REPORTS_KEY, 'reports');
      auditLog = readLocalList(AUDIT_KEY, 'change history');
      renderSummary();
      return;
    }
    if (!(await clearBackendOfflineCache())) return;
    try {
      const state = await apiRequest('state');
      if (state.user.role !== 'admin') {
        window.location.assign('index.php');
        return;
      }
      applyState(state);
      ui.notice.hidden = true;
      ui.identity.textContent = `${currentUser.username} · Admin`;
      ui.logout.hidden = false;
      ui.logoutCsrf.value = csrfToken;
      ui.badge.textContent = 'Secure server';
      ui.badge.classList.add('is-secure');
      renderSummary();
      wireAccounts();
      await loadUsers();
    } catch (error) {
      console.error('Unable to load admin dashboard:', error);
      ui.backendError.textContent = `Administration data could not be loaded. Refresh to try again. Details: ${error instanceof Error ? error.message : 'Unknown server error.'}`;
      ui.backendError.hidden = false;
    }
  }

  initialize().catch((error) => {
    console.error('Admin page initialization failed:', error);
    ui.backendError.textContent = error instanceof Error ? error.message : 'Administration could not start.';
    ui.backendError.hidden = false;
  });
})();
