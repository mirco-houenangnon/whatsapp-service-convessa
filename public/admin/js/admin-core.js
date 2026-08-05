    // ── AUTH CHECK ──
    const token = sessionStorage.getItem('admin_token');
    if (!token) window.location.replace('/admin/login');

    async function apiFetch(path, opts = {}) {
      const res = await fetch(path, {
        ...opts,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          ...(opts.headers || {})
        },
        credentials: 'same-origin'
      });
      if (res.status === 401) {
        sessionStorage.removeItem('admin_token');
        window.location.replace('/admin/login');
        throw new Error('Unauthorized');
      }
      return res;
    }

    // ── HELPERS ──
    function esc(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function initials(name) {
      if (!name) return 'A';
      return name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    }

    function formatDate(dateStr) {
      if (!dateStr) return '—';
      try {
        const d = new Date(dateStr);
        return d.toLocaleString('fr-FR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });
      } catch (_) { return '—'; }
    }

    function maskPhone(phone) {
      if (!phone) return '—';
      const s = String(phone).replace(/\D/g, '');
      if (s.length <= 7) return s;
      return s.slice(0, 4) + '****' + s.slice(-3);
    }

    // ── TOAST SYSTEM ──
    function showToast(msg, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;

      const icons = {
        success: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#25D366" stroke-width="2"/><path d="M9 12l2 2 4-4" stroke="#25D366" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        error:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#dc3545" stroke-width="2"/><line x1="15" y1="9" x2="9" y2="15" stroke="#dc3545" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="9" x2="15" y2="15" stroke="#dc3545" stroke-width="2" stroke-linecap="round"/></svg>',
        info:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#3b82f6" stroke-width="2"/><line x1="12" y1="8" x2="12" y2="12" stroke="#3b82f6" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16" r="1" fill="#3b82f6"/></svg>'
      };

      toast.innerHTML = (icons[type] || icons.info) + '<span class="toast-msg">' + esc(msg) + '</span>';
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // ── LOAD PROFILE ──
    async function loadProfile() {
      try {
        const res = await apiFetch('/api/admin/me');
        const data = await res.json();
        if (data.success && data.admin) {
          const a = data.admin;
          const name = esc(a.displayName || a.email || 'Admin');
          const ini = initials(a.displayName || a.email);
          // Header
          document.getElementById('adminAvatar').textContent = ini;
          document.getElementById('adminName').textContent = a.displayName || a.email || 'Admin';
          // Profile card
          document.getElementById('profileAvatar').textContent = ini;
          document.getElementById('profileName').textContent = a.displayName || '—';
          document.getElementById('profileEmail').textContent = a.email || '—';
          document.getElementById('profileLastLogin').textContent =
            a.lastLoginAt ? 'Dernière connexion : ' + formatDate(a.lastLoginAt) : 'Jamais connecté';
          // Pre-fill form
          document.getElementById('editName').value = a.displayName || '';
          document.getElementById('editEmail').value = a.email || '';
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') console.error('loadProfile error', e);
      }
    }

    // ── LOAD STATS ──
    async function loadStats() {
      try {
        const res = await apiFetch('/api/admin/stats');
        const data = await res.json();
        if (data.success && data.stats) {
          const s = data.stats;
          document.getElementById('statTotal').textContent = s.tenants?.total ?? '0';
          document.getElementById('statConnected').textContent = s.tenants?.connected ?? '0';
          document.getElementById('statUsers').textContent = s.users?.total ?? '0';
          document.getElementById('statMessages').textContent = s.messages?.today ?? '0';
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') {
          ['statTotal','statConnected','statUsers','statMessages'].forEach(id => {
            document.getElementById(id).textContent = '—';
          });
        }
      }
    }

    // ── STATUS BADGE HTML ──
    function statusBadge(status, suspended) {
      if (suspended) {
        return '<span class="badge" style="background:#fee2e2;color:#991b1b;border-color:#fca5a5;"><span class="badge-dot" style="background:#dc3545;"></span>Suspendu</span>';
      }
      const map = {
        connected: { cls: 'badge-connected', label: 'Connecté' },
        pending_qr: { cls: 'badge-pending', label: 'En attente QR' },
        disconnected: { cls: 'badge-disconnected', label: 'Déconnecté' }
      };
      const s = map[status] || { cls: 'badge-disconnected', label: esc(status || 'Inconnu') };
      return '<span class="badge ' + s.cls + '"><span class="badge-dot"></span>' + s.label + '</span>';
    }

    // ── LOAD TENANTS ──
    async function loadTenants() {
      const tbody = document.getElementById('tenantsBody');
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#e4e6ea" stroke-width="2"/></svg>Chargement…</div></td></tr>';
      try {
        const res = await apiFetch('/api/admin/tenants');
        const data = await res.json();
        if (data.success && Array.isArray(data.tenants) && data.tenants.length > 0) {
          tbody.innerHTML = data.tenants.map(t => {
            const qrBtn = t.status === 'pending_qr'
              ? '<button class="btn-sm" data-id="' + esc(t.tenantId || t.id) + '" onclick="openQrModal(this)">Voir QR</button>'
              : '';

            const isSuspended = t.suspended || t.suspended === 1;
            const suspendBtn = isSuspended
              ? '<button class="btn-sm" style="border-color:#25D366;color:#128C7E;" onclick="unsuspendTenant(\'' + esc(t.tenantId || t.id) + '\')">Réactiver</button>'
              : '<button class="btn-sm" style="border-color:#dc3545;color:#dc3545;" onclick="openSuspendModal(\'' + esc(t.tenantId || t.id) + '\',\'' + esc(t.name || '') + '\')">Suspendre</button>';

            return '<tr>' +
              '<td class="td-phone">' + esc(maskPhone(t.phone)) + '</td>' +
              '<td class="td-name">' + esc(t.name || '—') + '</td>' +
              '<td>' + statusBadge(t.status, isSuspended) + '</td>' +
              '<td>' + esc(formatDate(t.connectedAt)) + '</td>' +
              '<td>' + esc(formatDate(t.createdAt)) + '</td>' +
              '<td>' + qrBtn + '</td>' +
              '<td style="display:flex;gap:0.375rem;">' + suspendBtn + '</td>' +
              '</tr>';
          }).join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">' +
            '<svg width="36" height="36" viewBox="0 0 24 24" fill="none"><path d="M22 12h-4l-3 9L9 3l-3 9H2" stroke="#e4e6ea" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            'Aucun compte WhatsApp trouvé.</div></td></tr>';
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') {
          tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state" style="color:#dc3545;">Erreur lors du chargement.</div></td></tr>';
        }
      }
    }

    // ── MODAL ──
    function openQrModal(btn) {
      document.getElementById('qrModal').classList.add('open');
    }
    function closeQrModal() {
      document.getElementById('qrModal').classList.remove('open');
    }
    document.getElementById('modalCloseBtn').addEventListener('click', closeQrModal);
    document.getElementById('modalCloseFooter').addEventListener('click', closeQrModal);
    document.getElementById('qrModal').addEventListener('click', function(e) {
      if (e.target === this) closeQrModal();
    });

    // ── USAGE BADGE HTML (codes de parrainage / plans) ──
    function usageBadge(item) {
      if (item.unlimited) {
        return '<span class="badge-usage unlimited">Illimité</span>';
      }
      if (item.usageType === 'duration') {
        return '<span class="badge-usage">' + esc(item.usageValue) + ' jour(s)</span>';
      }
      if (item.usageType === 'requests') {
        return '<span class="badge-usage">' + esc(item.usageValue) + ' requête(s)</span>';
      }
      return '<span class="badge-usage">—</span>';
    }

    function formatPrice(price) {
      return Number(price || 0).toLocaleString('fr-FR') + ' Frs CFA';
    }

    // ── LOAD REFERRAL CODES ──
    async function loadReferralCodes() {
      const tbody = document.getElementById('referralCodesBody');
      tbody.innerHTML = '<tr><td colspan="3"><div class="empty-state">Chargement…</div></td></tr>';
      try {
        const res = await apiFetch('/api/admin/referral-codes');
        const data = await res.json();
        if (data.success && Array.isArray(data.codes) && data.codes.length > 0) {
          tbody.innerHTML = data.codes.map(c =>
            '<tr>' +
            '<td class="td-name">' + esc(c.code) + '</td>' +
            '<td>' + usageBadge(c) + '</td>' +
            '<td>' + esc(formatDate(c.createdAt)) + '</td>' +
            '</tr>'
          ).join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="3"><div class="empty-state">Aucun code de parrainage trouvé.</div></td></tr>';
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') {
          tbody.innerHTML = '<tr><td colspan="3"><div class="empty-state" style="color:#dc3545;">Erreur lors du chargement.</div></td></tr>';
        }
      }
    }

    // ── LOAD PLANS ──
    async function loadPlans() {
      const tbody = document.getElementById('plansBody');
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state">Chargement…</div></td></tr>';
      try {
        const res = await apiFetch('/api/admin/plans');
        const data = await res.json();
        if (data.success && Array.isArray(data.plans) && data.plans.length > 0) {
          tbody.innerHTML = data.plans.map(p =>
            '<tr>' +
            '<td class="td-name">' + esc(p.name) + '</td>' +
            '<td>' + esc(formatPrice(p.price)) + '</td>' +
            '<td>' + usageBadge(p) + '</td>' +
            '<td>' + esc(formatDate(p.createdAt)) + '</td>' +
            '</tr>'
          ).join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state">Aucun plan trouvé.</div></td></tr>';
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') {
          tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state" style="color:#dc3545;">Erreur lors du chargement.</div></td></tr>';
        }
      }
    }

    // Persisté en localStorage pour survivre à un rechargement de page (F5) :
    // sans ça, un refresh renvoyait toujours vers l'onglet "dashboard" par défaut.
    const ACTIVE_TAB_KEY = 'admin_active_tab';
    const views = {
      dashboard: document.getElementById('view-dashboard'),
      users:     document.getElementById('view-users'),
      account:   document.getElementById('view-account'),
      referrals: document.getElementById('view-referrals'),
      plans:     document.getElementById('view-plans'),
      database:  document.getElementById('view-database'),
      panel:     document.getElementById('view-panel'),
      contact:   document.getElementById('view-contact')
    };
    const mainContent = document.getElementById('mainContent');

    function activateTab(target, { persist = true } = {}) {
      if (!views[target]) target = 'dashboard';

      document.querySelectorAll('.nav-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === target);
      });

      // Toggle main padding class for panel view
      mainContent.classList.toggle('panel-view', target === 'panel');

      Object.keys(views).forEach(key => views[key].classList.remove('active'));
      views[target].classList.add('active');

      if (persist) sessionStorage.setItem(ACTIVE_TAB_KEY, target);

      // Lazy-load Panel WhatsApp — on charge l'iframe uniquement au premier clic
      // pour éviter qu'elle soit vide. Le panel est servi par Express sur le même
      // domaine/port que l'admin, donc window.location.origin fonctionne.
      if (target === 'panel') {
        const iframe = document.getElementById('panelIframe');
        if (iframe && !iframe.getAttribute('src')) {
          iframe.src = window.location.origin + '/whatsapp-panel';
        }
      }

      if (target === 'account')   loadProfile();
      if (target === 'users')     { if (typeof loadUsers === 'function') loadUsers(); }
      if (target === 'referrals') { if (typeof loadReferralCodes === 'function') loadReferralCodes(); }
      if (target === 'plans')     { if (typeof loadPlans === 'function') loadPlans(); }
      if (target === 'database')  { if (typeof window.initDatabaseTab === 'function') window.initDatabaseTab(); else window.addEventListener('dbTabReady', () => window.initDatabaseTab?.(), { once: true }); }
      if (target === 'contact')   { if (typeof loadContactMessages === 'function') { loadContactMessages(1); loadContactGroupStatus(); } }
    }

    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', function() { activateTab(this.dataset.tab); });
    });

    // ── OPEN PANEL BTN ──
    document.getElementById('openPanelBtn').addEventListener('click', function() { activateTab('panel'); });
    // ── REFRESH BTN ──
    document.getElementById('refreshBtn').addEventListener('click', function() {
      this.disabled = true;
      Promise.all([loadStats(), loadTenants()]).finally(() => {
        this.disabled = false;
      });
    });

    // ── PROFILE FORM ──
    document.getElementById('profileForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('saveProfileBtn');
      const sp  = document.getElementById('spinnerProfile');
      btn.disabled = true;
      sp.classList.add('active');
      try {
        const res = await apiFetch('/api/admin/me', {
          method: 'PUT',
          body: JSON.stringify({
            displayName: document.getElementById('editName').value.trim(),
            email: document.getElementById('editEmail').value.trim()
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Profil mis à jour avec succès.', 'success');
          await loadProfile();
        } else {
          showToast(data.message || 'Erreur lors de la mise à jour.', 'error');
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') showToast('Erreur réseau.', 'error');
      } finally {
        btn.disabled = false;
        sp.classList.remove('active');
      }
    });

    // ── PASSWORD FORM ──
    document.getElementById('passwordForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      const currentPwd = document.getElementById('currentPwd').value;
      const newPwd     = document.getElementById('newPwd').value;
      const confirmPwd = document.getElementById('confirmPwd').value;

      if (!currentPwd || !newPwd || !confirmPwd) {
        showToast('Veuillez remplir tous les champs.', 'error'); return;
      }
      if (newPwd.length < 8) {
        showToast('Le nouveau mot de passe doit contenir au moins 8 caractères.', 'error'); return;
      }
      if (newPwd !== confirmPwd) {
        showToast('Les mots de passe ne correspondent pas.', 'error'); return;
      }

      const btn = document.getElementById('savePwdBtn');
      const sp  = document.getElementById('spinnerPwd');
      btn.disabled = true;
      sp.classList.add('active');
      try {
        const res = await apiFetch('/api/admin/me/password', {
          method: 'PUT',
          body: JSON.stringify({ currentPassword: currentPwd, newPassword: newPwd })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Mot de passe mis à jour avec succès.', 'success');
          document.getElementById('passwordForm').reset();
        } else {
          showToast(data.message || 'Erreur lors de la mise à jour.', 'error');
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') showToast('Erreur réseau.', 'error');
      } finally {
        btn.disabled = false;
        sp.classList.remove('active');
      }
    });

    // ── PROFILE LINK (clic sur l'avatar/nom admin) ──
    document.getElementById('profileLink').addEventListener('click', function() {
      activateTab('account');
    });

    // ── LOGOUT ──
    document.getElementById('logoutBtn').addEventListener('click', async function() {
      this.disabled = true;
      try {
        await apiFetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
      } finally {
        sessionStorage.removeItem('admin_token');
        window.location.replace('/admin/login');
      }
    });

    // ── HAMBURGER DRAWER MOBILE ──
    const hamburgerBtn   = document.getElementById('hamburgerBtn');
    const mobileDrawer   = document.getElementById('mobileDrawer');
    const mobileOverlay  = document.getElementById('mobileOverlay');
    const mobileClose    = document.getElementById('mobileDrawerClose');
    const mobileLogout   = document.getElementById('mobileLogoutBtn');

    function openDrawer()  { mobileDrawer.classList.add('open'); document.body.style.overflow = 'hidden'; }
    function closeDrawer() { mobileDrawer.classList.remove('open'); document.body.style.overflow = ''; }

    if (hamburgerBtn) hamburgerBtn.addEventListener('click', openDrawer);
    if (mobileClose)  mobileClose.addEventListener('click', closeDrawer);
    if (mobileOverlay) mobileOverlay.addEventListener('click', closeDrawer);

    // Onglets mobiles → même action que les onglets desktop + fermeture du drawer
    document.querySelectorAll('.mobile-nav-tab').forEach(btn => {
      btn.addEventListener('click', function() {
        const tab = this.dataset.tab;
        activateTab(tab);
        // Mettre à jour l'état actif dans le drawer
        document.querySelectorAll('.mobile-nav-tab').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        closeDrawer();
      });
    });

    // Synchroniser l'état actif du drawer quand un onglet desktop est cliqué
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', function() {
        const tab = this.dataset.tab;
        document.querySelectorAll('.mobile-nav-tab').forEach(b => {
          b.classList.toggle('active', b.dataset.tab === tab);
        });
      });
    });

    // Logout depuis le drawer
    if (mobileLogout) {
      mobileLogout.addEventListener('click', async function() {
        this.disabled = true;
        try { await apiFetch('/api/admin/logout', { method: 'POST' }).catch(() => {}); }
        finally { sessionStorage.removeItem('admin_token'); window.location.replace('/admin/login'); }
      });
    }

    // --
    // ONGLET "MESSAGERIE" — liste + fil de discussion WhatsApp