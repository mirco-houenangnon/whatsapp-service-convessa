  // --------------------------------------------------------------------------------------------------------------------------------------------
  // ONGLET "BASE DE DONNÉES" — DB Browser générique + Gestion de profils
  // --------------------------------------------------------------------------------------------------------------------------------------------
  (function () {
    const state = {
      initialized: false,
      tablesMeta:  [],              // métadonnées de toutes les tables (SCHEMA whitelisté côté serveur)
      currentTable: null,
      rowsPage:  1,
      rowsLimit: 25,
      rowsSearch: '',

      profilesPage: 1,
      profilesLimit: 20,
      profilesSearch: '',
      currentUid: null,
    };

    function tableMetaByName(name) {
      return state.tablesMeta.find(t => t.name === name) || null;
    }

    function inputTypeFor(col) {
      if (col.type === 'boolean') return 'checkbox';
      if (col.type === 'number')  return 'number';
      // 'date' reste en texte libre (format ISO 8601) : les <input type="datetime-local">
      // n'acceptent pas le format complet renvoyé par Postgres (millisecondes + "Z").
      return 'text';
    }

    function formatCellValue(col, value) {
      if (value === null || value === undefined) return '<span style="color:#c0c6cc;">NULL</span>';
      if (col.sensitive) return esc(value);
      if (col.type === 'boolean') return value ? 'Oui' : 'Non';
      if (col.type === 'date') return esc(formatDate(value));
      if (col.type === 'json') return '<code style="font-size:0.78rem;">' + esc(JSON.stringify(value)) + '</code>';
      const str = String(value);
      return esc(str.length > 80 ? str.slice(0, 80) + '…' : str);
    }

    // ── INITIALISATION (appelée à la première ouverture de l'onglet) ──
    async function initDatabaseTab() {
      if (state.initialized) return;
      state.initialized = true;
      try {
        const res = await apiFetch('/api/admin/db/tables');
        const data = await res.json();
        if (data.success) {
          state.tablesMeta = data.tables;
          const select = document.getElementById('dbTableSelect');
          select.innerHTML = state.tablesMeta.map(t => `<option value="${esc(t.name)}">${esc(t.label)}</option>`).join('');
          state.currentTable = state.tablesMeta[0]?.name || null;
          if (state.currentTable) loadDbRows(1);
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') showToast('Erreur lors du chargement des tables.', 'error');
      }
      loadProfilesList(1);
    }
    window.initDatabaseTab = initDatabaseTab;
    // Signale au premier script que initDatabaseTab est maintenant disponible
    // (utile si l'onglet "database" était actif au moment du rechargement)
    window.dispatchEvent(new Event('dbTabReady'));

    // ── SWITCH MODE TABLE / PROFILS ──
    document.getElementById('dbModeTablesBtn').addEventListener('click', () => switchDbMode('tables'));
    document.getElementById('dbModeProfilesBtn').addEventListener('click', () => switchDbMode('profiles'));
    function switchDbMode(mode) {
      document.getElementById('dbModeTablesBtn').classList.toggle('active', mode === 'tables');
      document.getElementById('dbModeProfilesBtn').classList.toggle('active', mode === 'profiles');
      document.getElementById('dbSubTables').classList.toggle('active', mode === 'tables');
      document.getElementById('dbSubProfiles').classList.toggle('active', mode === 'profiles');
    }

    // -------------------------------------- MODE TABLE (façon phpMyAdmin) --------------------------------------

    document.getElementById('dbTableSelect').addEventListener('change', function () {
      state.currentTable = this.value;
      loadDbRows(1);
    });
    document.getElementById('dbRefreshRowsBtn').addEventListener('click', () => loadDbRows(state.rowsPage));
    document.getElementById('dbSearchInput').addEventListener('input', debounce(function () {
      state.rowsSearch = this.value.trim();
      loadDbRows(1);
    }, 350));
    document.getElementById('dbNewRowBtn').addEventListener('click', () => openDbRowModal('create'));
    document.getElementById('dbRowsPrevBtn').addEventListener('click', () => loadDbRows(state.rowsPage - 1));
    document.getElementById('dbRowsNextBtn').addEventListener('click', () => loadDbRows(state.rowsPage + 1));

    function debounce(fn, ms) {
      let t;
      return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
    }

    async function loadDbRows(page = 1) {
      if (!state.currentTable) return;
      const thead = document.getElementById('dbRowsThead');
      const tbody = document.getElementById('dbRowsBody');
      tbody.innerHTML = `<tr><td><div class="empty-state">Chargement…</div></td></tr>`;

      try {
        const params = new URLSearchParams({ page, limit: state.rowsLimit });
        if (state.rowsSearch) params.set('search', state.rowsSearch);
        const res = await apiFetch(`/api/admin/db/tables/${encodeURIComponent(state.currentTable)}/rows?${params}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error?.message || 'Erreur');

        state.rowsPage = page;
        const meta = data.table;

        thead.innerHTML = '<tr>' + meta.columns.map(c =>
          `<th>${esc(c.name)}${c.sensitive ? ' 🔒' : ''}${meta.pk.includes(c.name) ? ' 🔑' : ''}</th>`
        ).join('') + '<th>Actions</th></tr>';

        if (data.rows.length === 0) {
          tbody.innerHTML = `<tr><td colspan="${meta.columns.length + 1}"><div class="empty-state">Aucune ligne trouvée.</div></td></tr>`;
        } else {
          tbody.innerHTML = data.rows.map(row => {
            const pkValues = meta.pk.map(c => row[c]);
            const cells = meta.columns.map(c => {
              const cls = c.sensitive ? 'cell-sensitive' : (meta.pk.includes(c.name) ? 'cell-readonly' : '');
              return `<td class="${cls}">${formatCellValue(c, row[c.name])}</td>`;
            }).join('');
            const pkEnc = encodeURIComponent(JSON.stringify(pkValues));
            return `<tr>${cells}<td class="row-actions-cell">
              <button class="btn-icon-sm edit" title="Éditer" onclick="__dbEditRow('${pkEnc}')">✎</button>
              <button class="btn-icon-sm danger" title="Supprimer" onclick="__dbDeleteRow('${pkEnc}')">🗑</button>
            </td></tr>`;
          }).join('');
        }

        const pages = Math.max(1, data.meta.pages);
        document.getElementById('dbRowsPagination').style.display = data.total > state.rowsLimit ? 'flex' : 'none';
        document.getElementById('dbRowsPaginationInfo').textContent = `Page ${page} sur ${pages} (${data.total} lignes)`;
        document.getElementById('dbRowsPrevBtn').disabled = page <= 1;
        document.getElementById('dbRowsNextBtn').disabled = page >= pages;
      } catch (e) {
        if (e.message !== 'Unauthorized') {
          tbody.innerHTML = `<tr><td><div class="empty-state" style="color:#dc3545;">${esc(e.message || 'Erreur lors du chargement.')}</div></td></tr>`;
        }
      }
    }

    window.__dbEditRow = function (pkEnc) { openDbRowModal('edit', JSON.parse(decodeURIComponent(pkEnc))); };
    window.__dbDeleteRow = async function (pkEnc) {
      if (!confirm('Supprimer définitivement cette ligne ? Cette action est irréversible.')) return;
      const pkValues = JSON.parse(decodeURIComponent(pkEnc));
      try {
        const res = await apiFetch(`/api/admin/db/tables/${encodeURIComponent(state.currentTable)}/rows/${encodeURIComponent(JSON.stringify(pkValues))}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) { showToast('Ligne supprimée.', 'success'); loadDbRows(state.rowsPage); }
        else showToast(data.error?.message || 'Erreur lors de la suppression.', 'error');
      } catch (e) { if (e.message !== 'Unauthorized') showToast('Erreur réseau.', 'error'); }
    };

    let dbRowModalMode = 'create';
    let dbRowModalPk = null;

    async function openDbRowModal(mode, pkValues) {
      const meta = tableMetaByName(state.currentTable);
      if (!meta) return;
      dbRowModalMode = mode;
      dbRowModalPk = pkValues || null;

      document.getElementById('dbRowModalTitle').textContent = mode === 'create'
        ? `Nouvelle ligne — ${meta.label}` : `Éditer — ${meta.label}`;

      let row = {};
      if (mode === 'edit') {
        try {
          const res = await apiFetch(`/api/admin/db/tables/${encodeURIComponent(state.currentTable)}/rows/${encodeURIComponent(JSON.stringify(pkValues))}`);
          const data = await res.json();
          if (!data.success) { showToast(data.error?.message || 'Ligne introuvable.', 'error'); return; }
          row = data.row;
        } catch (e) { if (e.message !== 'Unauthorized') showToast('Erreur réseau.', 'error'); return; }
      }

      const body = document.getElementById('dbRowFormBody');
      body.innerHTML = meta.columns.map(col => {
        const isPk = meta.pk.includes(col.name);
        const disabled = col.sensitive || (mode === 'edit' && isPk) || col.generated;
        const hint = col.sensitive ? 'Champ protégé, non modifiable.' : (col.generated ? 'Généré automatiquement.' : '');
        const val = row[col.name];

        if (col.type === 'boolean') {
          return `<div class="form-group"><label><input type="checkbox" data-col="${esc(col.name)}" ${val ? 'checked' : ''} ${disabled ? 'disabled' : ''} style="width:auto;margin-right:0.5rem;" />${esc(col.name)}</label>${hint ? `<span class="field-hint">${hint}</span>` : ''}</div>`;
        }
        if (col.type === 'json') {
          const jsonStr = (val && !col.sensitive) ? JSON.stringify(val, null, 2) : '';
          return `<div class="form-group"><label>${esc(col.name)}</label><textarea data-col="${esc(col.name)}" data-type="json" ${disabled ? 'disabled' : ''}>${esc(jsonStr)}</textarea>${hint ? `<span class="field-hint">${hint}</span>` : ''}</div>`;
        }
        const displayVal = col.sensitive ? '' : (val ?? '');
        const placeholder = col.sensitive ? '•••••• (non affiché)' : '';
        return `<div class="form-group"><label>${esc(col.name)}${col.required ? ' *' : ''}</label>
          <input type="${inputTypeFor(col)}" data-col="${esc(col.name)}" value="${esc(displayVal)}" placeholder="${placeholder}" ${disabled ? 'disabled' : ''} />
          ${hint ? `<span class="field-hint">${hint}</span>` : ''}</div>`;
      }).join('');

      document.getElementById('dbRowModal').classList.add('open');
    }

    document.getElementById('dbRowForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      const meta = tableMetaByName(state.currentTable);
      const inputs = document.querySelectorAll('#dbRowFormBody [data-col]');
      const payload = {};
      inputs.forEach(inp => {
        if (inp.disabled) return;
        const col = inp.dataset.col;
        if (inp.type === 'checkbox') { payload[col] = inp.checked; return; }
        if (inp.dataset.type === 'json') {
          const raw = inp.value.trim();
          payload[col] = raw ? JSON.parse(raw) : null;
          return;
        }
        if (inp.value === '') { payload[col] = null; return; }
        payload[col] = inp.type === 'number' ? Number(inp.value) : inp.value;
      });
      if (dbRowModalMode === 'create') {
        meta.pk.forEach(pkCol => {
          const pkInput = document.querySelector(`#dbRowFormBody [data-col="${pkCol}"]`);
          if (pkInput && !pkInput.disabled && !payload[pkCol]) delete payload[pkCol];
        });
      }

      const btn = document.getElementById('dbRowSaveBtn');
      const sp  = document.getElementById('dbRowSpinner');
      btn.disabled = true; sp.classList.add('active');
      try {
        let res;
        if (dbRowModalMode === 'create') {
          res = await apiFetch(`/api/admin/db/tables/${encodeURIComponent(state.currentTable)}/rows`, { method: 'POST', body: JSON.stringify(payload) });
        } else {
          res = await apiFetch(`/api/admin/db/tables/${encodeURIComponent(state.currentTable)}/rows/${encodeURIComponent(JSON.stringify(dbRowModalPk))}`, { method: 'PUT', body: JSON.stringify(payload) });
        }
        const data = await res.json();
        if (data.success) {
          showToast(dbRowModalMode === 'create' ? 'Ligne créée avec succès.' : 'Ligne mise à jour.', 'success');
          document.getElementById('dbRowModal').classList.remove('open');
          loadDbRows(state.rowsPage);
        } else {
          showToast(data.error?.message || 'Erreur lors de l\'enregistrement.', 'error');
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') showToast(err instanceof SyntaxError ? 'JSON invalide dans un champ.' : 'Erreur réseau.', 'error');
      } finally {
        btn.disabled = false; sp.classList.remove('active');
      }
    });

    document.getElementById('dbRowModalCloseBtn').addEventListener('click', () => document.getElementById('dbRowModal').classList.remove('open'));
    document.getElementById('dbRowModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });

    // -------------------------------------- MODE PROFILS --------------------------------------

    document.getElementById('profileSearchInput').addEventListener('input', debounce(function () {
      state.profilesSearch = this.value.trim();
      loadProfilesList(1);
    }, 350));
    document.getElementById('dbRefreshProfilesBtn').addEventListener('click', () => loadProfilesList(state.profilesPage));
    document.getElementById('profilesPrevBtn').addEventListener('click', () => loadProfilesList(state.profilesPage - 1));
    document.getElementById('profilesNextBtn').addEventListener('click', () => loadProfilesList(state.profilesPage + 1));
    document.getElementById('profileBackBtn').addEventListener('click', () => {
      document.getElementById('dbProfileDetailWrap').style.display = 'none';
      document.getElementById('dbProfileListWrap').style.display = 'block';
    });

    async function loadProfilesList(page = 1) {
      const tbody = document.getElementById('profilesBody');
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Chargement…</div></td></tr>`;
      try {
        const params = new URLSearchParams({ page, limit: state.profilesLimit });
        if (state.profilesSearch) params.set('search', state.profilesSearch);
        const res = await apiFetch(`/api/admin/profiles?${params}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error?.message || 'Erreur');

        state.profilesPage = page;
        if (data.profiles.length === 0) {
          tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Aucun profil trouvé.</div></td></tr>`;
        } else {
          tbody.innerHTML = data.profiles.map(p => {
            const isAdmin = p.profile_type === 'admin';
            const badge = isAdmin
              ? '<span class="user-badge" style="background:linear-gradient(135deg,#fee2e2,#fecaca);color:#991b1b;border:1px solid #fca5a5;">🛡 Admin</span>'
              : `<span class="user-badge ${p.active ? 'active' : 'inactive'}">${p.active ? 'Actif' : 'Inactif'}</span>`;
            const tenantsBadge = isAdmin
              ? '<span style="font-size:0.8rem;color:#667781;">—</span>'
              : `<span style="font-weight:600;">${p.tenants_count}</span>`;
            return `
            <tr class="profile-row" onclick="__openProfile('${esc(p.uid)}')">
              <td class="user-info-cell">
                <div class="user-avatar-table" style="${isAdmin ? 'background:linear-gradient(135deg,#dc3545,#991b1b);' : ''}">${esc(initials(p.display_name || p.email))}</div>
                <div class="user-details">
                  <span class="user-name">${esc(p.display_name || 'Sans nom')}</span>
                  <span class="user-id">${esc(p.uid)}</span>
                </div>
              </td>
              <td class="contact-info">
                <span class="contact-item">${esc(p.email || '—')}</span>
                <span class="contact-item">${esc(maskPhone(p.phone))}</span>
              </td>
              <td>${tenantsBadge}</td>
              <td>${badge}</td>
              <td class="date-display">${esc(formatDate(p.created_at))}</td>
            </tr>`;
          }).join('');
        }
        const pages = Math.max(1, data.meta.pages);
        document.getElementById('profilesPagination').style.display = data.meta.total > state.profilesLimit ? 'flex' : 'none';
        document.getElementById('profilesPaginationInfo').textContent = `Page ${page} sur ${pages} (${data.meta.total} profils)`;
        document.getElementById('profilesPrevBtn').disabled = page <= 1;
        document.getElementById('profilesNextBtn').disabled = page >= pages;
      } catch (e) {
        if (e.message !== 'Unauthorized') tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="color:#dc3545;">Erreur lors du chargement.</div></td></tr>`;
      }
    }

    window.__openProfile = async function (uid) {
      state.currentUid = uid;
      document.getElementById('dbProfileListWrap').style.display = 'none';
      document.getElementById('dbProfileDetailWrap').style.display = 'block';
      document.getElementById('pdSections').innerHTML = `<div class="empty-state">Chargement du profil…</div>`;
      try {
        const res = await apiFetch(`/api/admin/profiles/${encodeURIComponent(uid)}`);
        const data = await res.json();
        if (!data.success) { showToast(data.error?.message || 'Profil introuvable.', 'error'); return; }
        renderProfileDetail(data.profile);
      } catch (e) { if (e.message !== 'Unauthorized') showToast('Erreur réseau.', 'error'); }
    };

    function renderProfileDetail(profile) {
      const acc = profile.account || {};

      // ── Profil admin Convessa ──────────────────────────────────────────────
      if (profile.profile_type === 'admin') {
        document.getElementById('pdAvatar').textContent = initials(acc.display_name || acc.email);
        document.getElementById('pdName').textContent = acc.display_name || acc.email || 'Admin';
        document.getElementById('pdSub').textContent = [acc.email, 'Administrateur Convessa'].filter(Boolean).join(' • ');

        const sections = document.getElementById('pdSections');
        sections.innerHTML = '';

        // Fiche admin avec libellés lisibles
        sections.appendChild(buildAdminSection('Compte Administrateur', acc));
        if (profile.adminSession) {
          sections.appendChild(buildSection('Session Baileys (compte WhatsApp admin)', 'wa_sessions', [profile.adminSession]));
        } else {
          const noSession = document.createElement('div');
          noSession.className = 'table-card db-section-card';
          noSession.innerHTML = '<div class="db-section-title-row"><span class="section-title">Session Baileys (compte WhatsApp admin)</span></div><div class="db-empty-note">Aucune session Baileys trouvée pour l\'admin (id = "admin").</div>';
          sections.appendChild(noSession);
        }
        return;
      }

      // ── Profil utilisateur Firebase ────────────────────────────────────────
      document.getElementById('pdAvatar').textContent = initials(acc.display_name || acc.email);
      document.getElementById('pdName').textContent = acc.display_name || acc.email || acc.uid;
      document.getElementById('pdSub').textContent = [acc.email, maskPhone(acc.phone)].filter(Boolean).join(' • ');

      const sections = document.getElementById('pdSections');
      sections.innerHTML = '';
      sections.appendChild(buildSection('Compte Utilisateur', 'auth_users', acc ? [acc] : []));
      sections.appendChild(buildSection('Comptes WhatsApp (tenants)', 'wa_tenants', profile.tenants));
      sections.appendChild(buildSection('Sessions Baileys (credentials WhatsApp)', 'wa_sessions', profile.sessions));
      sections.appendChild(buildSection('Groupes WhatsApp', 'wa_groups', profile.groups));
      sections.appendChild(buildSection('Messages envoyés (200 derniers)', 'wa_messages', profile.messages));
      sections.appendChild(buildSection('Paiements d\'abonnement', 'subscription_payments', profile.payments));
      sections.appendChild(buildSection('Appareils enregistrés', 'auth_devices', profile.devices));
      sections.appendChild(buildSection('Journal de sécurité (100 derniers)', 'auth_device_sessions', profile.securityLogs));
    }

    // ── MAP DE LIBELLÉS lisibles pour les colonnes de toutes les tables ────────
    const COL_LABELS = {
      // auth_users
      uid: 'UID Firebase', email: 'Adresse e-mail', display_name: 'Nom d\'affichage',
      photo_url: 'Photo URL', provider: 'Fournisseur', phone: 'Téléphone',
      active: 'Actif', created_at: 'Créé le', last_login_at: 'Dernière connexion',
      // convessa_admins
      id: 'ID', password_hash: 'Hash mot de passe (🔒)', updated_at: 'Modifié le',
      // wa_tenants
      user_uid: 'UID Utilisateur', name: 'Nom', api_key_hash: 'Hash Clé API (🔒)',
      api_key_hint: 'Aperçu Clé API', api_key_enc: 'Clé API chiffrée (🔒)',
      api_key_iv: 'IV chiffrement (🔒)', api_key_tag: 'Tag chiffrement (🔒)',
      api_key_expires_at: 'Expiration Clé API', webhook_url: 'URL Webhook',
      status: 'Statut', usage_type: 'Type d\'usage', messages_limit: 'Limite messages',
      messages_sent: 'Messages envoyés', referral_code: 'Code de parrainage',
      connected_at: 'Connecté le',
      // wa_sessions
      creds_iv: 'IV credentials (🔒)', creds_tag: 'Tag credentials (🔒)',
      creds_data: 'Données credentials (🔒)',
      // wa_session_keys
      session_id: 'ID Session', key_type: 'Type de clé', key_id: 'ID Clé',
      key_value: 'Valeur (🔒)',
      // wa_message_queue / wa_messages
      tenant_id: 'ID Tenant', recipient: 'Destinataire', jid: 'JID WhatsApp',
      message: 'Message', media_type: 'Type média', media_url: 'URL média',
      media_b64: 'Média base64 (🔒)', media_mime: 'MIME type', media_name: 'Nom fichier',
      attempts: 'Tentatives', last_error: 'Dernière erreur', queued_at: 'Mis en file le',
      sent_at: 'Envoyé le', to_jid: 'Destinataire JID', to_type: 'Type dest.',
      has_media: 'Contient média', error_code: 'Code erreur', error_message: 'Message d\'erreur',
      wa_message_id: 'ID message WhatsApp',
      // wa_groups
      wa_group_jid: 'JID du groupe', invite_code: 'Code d\'invitation',
      invite_code_generated_at: 'Invitation générée le', participants_count: 'Nb participants',
      // auth_devices
      fingerprint_hash: 'Empreinte appareil', first_ip: 'Première IP',
      user_agent: 'User-Agent', accept_language: 'Langue', client_hints: 'Client Hints',
      first_seen_at: 'Première apparition', last_seen_at: 'Dernière apparition',
      blocked: 'Bloqué', blocked_reason: 'Raison blocage', registered_uid: 'UID enregistré',
      // auth_device_sessions
      device_id: 'ID Appareil', user_uid: 'UID Utilisateur', ip: 'Adresse IP',
      action: 'Action', meta: 'Métadonnées',
      // subscription_payments
      plan_id: 'ID Plan', gateway: 'Passerelle', gateway_tx_id: 'ID Transaction',
      amount: 'Montant', currency: 'Devise',
      // referral_codes / subscription_plans
      code: 'Code', unlimited: 'Illimité', usage_value: 'Valeur d\'usage',
      price: 'Prix', description: 'Description', features: 'Fonctionnalités',
      is_popular: 'Populaire',
      // wa_logs
      level: 'Niveau', component: 'Composant', context: 'Contexte',
    };
    function colLabel(name) { return COL_LABELS[name] || name; }

    // ── Fiche lisible pour un admin Convessa ──────────────────────────────────
    function buildAdminSection(title, acc) {
      const wrap = document.createElement('div');
      wrap.className = 'table-card db-section-card';

      const adminMeta = tableMetaByName('convessa_admins');
      if (!acc || !adminMeta) {
        wrap.innerHTML = `<div class="db-section-title-row"><span class="section-title">${esc(title)}</span></div><div class="db-empty-note">Aucune donnée.</div>`;
        return wrap;
      }

      // Construire une fiche verticale avec champs et libellés lisibles
      const fields = [
        { label: 'ID',                  value: acc.id,            editable: false },
        { label: 'Adresse e-mail',      value: acc.email,         editable: true,  col: 'email',        type: 'text',    pk: [acc.id] },
        { label: 'Nom d\'affichage',    value: acc.display_name,  editable: true,  col: 'display_name', type: 'text',    pk: [acc.id] },
        { label: 'Actif',               value: acc.active ? 'Oui' : 'Non', editable: true, col: 'active', type: 'boolean', pk: [acc.id] },
        { label: 'Hash mot de passe',   value: acc.password_hash, editable: false, sensitive: true },
        { label: 'Créé le',             value: formatDate(acc.created_at), editable: false },
        { label: 'Modifié le',          value: formatDate(acc.updated_at), editable: false },
        { label: 'Dernière connexion',  value: formatDate(acc.last_login_at), editable: false },
      ];

      let fieldsHtml = fields.map(f => {
        const valDisplay = f.sensitive
          ? '<span style="color:#b45309;font-style:italic;">•••••• (protégé)</span>'
          : (f.value == null ? '<span style="color:#c0c6cc;">—</span>' : esc(String(f.value)));

        if (f.editable) {
          const rawEnc = esc(JSON.stringify(f.value === undefined ? null : (acc[f.col] ?? null)));
          return `<tr>
            <td style="font-weight:600;color:#374151;width:220px;padding:0.875rem 1.25rem;background:#f9fafb;border-right:2px solid #e4e6ea;">${esc(f.label)}</td>
            <td class="cell-editable"
                data-pk='${esc(JSON.stringify(f.pk))}'
                data-raw='${rawEnc}'
                data-table="convessa_admins"
                data-col="${esc(f.col)}"
                data-type="${esc(f.type)}"
                onclick="__editProfileField(this)"
                style="padding:0.875rem 1.25rem;">${valDisplay}
              <span style="float:right;font-size:0.75rem;color:#25D366;opacity:0.7;">✎ modifier</span>
            </td>
          </tr>`;
        }
        return `<tr>
          <td style="font-weight:600;color:#374151;width:220px;padding:0.875rem 1.25rem;background:#f9fafb;border-right:2px solid #e4e6ea;">${esc(f.label)}</td>
          <td class="${f.sensitive ? 'cell-sensitive' : 'cell-readonly'}" style="padding:0.875rem 1.25rem;">${valDisplay}</td>
        </tr>`;
      }).join('');

      wrap.innerHTML = `
        <div class="db-section-title-row">
          <span class="section-title">${esc(title)}</span>
          <span style="font-size:0.8rem;color:#667781;background:#fee2e2;color:#991b1b;padding:0.25rem 0.6rem;border-radius:6px;font-weight:600;">🛡 Admin Convessa</span>
        </div>
        <div class="table-wrap"><table style="min-width:unset;width:100%;">
          <tbody>${fieldsHtml}</tbody>
        </table></div>`;
      return wrap;
    }

    function buildSection(title, tableName, rows) {
      const wrap = document.createElement('div');
      wrap.className = 'table-card db-section-card';
      const meta = tableMetaByName(tableName);

      if (!meta || !rows || rows.length === 0) {
        wrap.innerHTML = `<div class="db-section-title-row"><span class="section-title">${esc(title)}</span></div><div class="db-empty-note">Aucune donnée.</div>`;
        return wrap;
      }

      const editableCols = meta.columns.filter(c => !c.sensitive && !meta.pk.includes(c.name));
      const displayCols = meta.columns; // on affiche toutes les colonnes ; les sensibles sont masquées côté API

      let html = `<div class="db-section-title-row"><span class="section-title">${esc(title)}</span><span style="font-size:0.8rem;color:#667781;">${rows.length} ligne(s)</span></div>
        <div class="table-wrap"><table><thead><tr>${displayCols.map(c => `<th title="${esc(c.name)}">${esc(colLabel(c.name))}</th>`).join('')}</tr></thead><tbody>`;

      rows.forEach(row => {
        const pkValues = meta.pk.map(c => row[c]);
        const pkEnc = esc(JSON.stringify(pkValues));
        html += '<tr>' + displayCols.map(c => {
          const editable = editableCols.includes(c);
          if (!editable) {
            const cls = c.sensitive ? 'cell-sensitive' : 'cell-readonly';
            return `<td class="${cls}">${formatCellValue(c, row[c.name])}</td>`;
          }
          const rawEnc = esc(JSON.stringify(row[c.name] === undefined ? null : row[c.name]));
          return `<td class="cell-editable" data-pk='${pkEnc}' data-raw='${rawEnc}' data-table="${esc(tableName)}" data-col="${esc(c.name)}" data-type="${esc(c.type)}" onclick="__editProfileField(this)">${formatCellValue(c, row[c.name])}</td>`;
        }).join('') + '</tr>';
      });

      html += '</tbody></table></div>';
      wrap.innerHTML = html;
      return wrap;
    }

    window.__editProfileField = function (td) {
      const table  = td.dataset.table;
      const column = td.dataset.col;
      const type   = td.dataset.type;
      const pk     = JSON.parse(td.dataset.pk);
      const meta   = tableMetaByName(table);
      const col    = meta.columns.find(c => c.name === column);

      document.getElementById('fieldEditModalTitle').textContent = `${meta.label} — ${colLabel(column)}`;
      const body = document.getElementById('fieldEditFormBody');

      // On repart toujours de la valeur brute (non formatée) stockée dans data-raw,
      // jamais du texte affiché (formaté en fr-FR), pour éviter d'envoyer une date
      // ou un JSON mal formé au serveur.
      let rawValue = null;
      try { rawValue = JSON.parse(td.dataset.raw); } catch { rawValue = null; }

      if (type === 'boolean') {
        body.innerHTML = `<div class="form-group"><label>${esc(column)}</label>
          <select data-value><option value="true">Oui</option><option value="false">Non</option></select></div>`;
        body.querySelector('[data-value]').value = rawValue ? 'true' : 'false';
      } else if (type === 'json') {
        const jsonStr = rawValue !== null ? JSON.stringify(rawValue, null, 2) : '';
        body.innerHTML = `<div class="form-group"><label>${esc(column)} (JSON)</label><textarea data-value>${esc(jsonStr)}</textarea></div>`;
      } else if (type === 'date') {
        body.innerHTML = `<div class="form-group"><label>${esc(column)}</label>
          <input type="text" data-value value="${esc(rawValue ?? '')}" placeholder="ex: 2026-07-30T10:00:00.000Z" />
          <span class="field-hint">Format ISO 8601 (laisser tel quel si non modifié).</span></div>`;
      } else {
        body.innerHTML = `<div class="form-group"><label>${esc(column)}</label>
          <input type="${inputTypeFor(col)}" data-value value="${esc(rawValue ?? '')}" /></div>`;
      }

      document.getElementById('fieldEditForm').dataset.table = table;
      document.getElementById('fieldEditForm').dataset.pk = JSON.stringify(pk);
      document.getElementById('fieldEditForm').dataset.column = column;
      document.getElementById('fieldEditForm').dataset.type = type;
      document.getElementById('fieldEditModal').classList.add('open');
    };

    document.getElementById('fieldEditForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      const form = this;
      const table  = form.dataset.table;
      const pk     = JSON.parse(form.dataset.pk);
      const column = form.dataset.column;
      const type   = form.dataset.type;
      const raw = form.querySelector('[data-value]').value;

      let value = raw;
      if (type === 'boolean') value = raw === 'true';
      else if (type === 'number') value = raw === '' ? null : Number(raw);
      else if (type === 'json') { try { value = raw.trim() ? JSON.parse(raw) : null; } catch { showToast('JSON invalide.', 'error'); return; } }
      else if (raw === '') value = null;

      const btn = document.getElementById('fieldEditSaveBtn');
      const sp  = document.getElementById('fieldEditSpinner');
      btn.disabled = true; sp.classList.add('active');
      try {
        const res = await apiFetch(`/api/admin/profiles/${encodeURIComponent(state.currentUid)}/field`, {
          method: 'PUT',
          body: JSON.stringify({ table, pk, column, value })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Champ mis à jour.', 'success');
          document.getElementById('fieldEditModal').classList.remove('open');
          window.__openProfile(state.currentUid);
        } else {
          showToast(data.error?.message || 'Erreur lors de la mise à jour.', 'error');
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') showToast('Erreur réseau.', 'error');
      } finally {
        btn.disabled = false; sp.classList.remove('active');
      }
    });
    document.getElementById('fieldEditCloseBtn').addEventListener('click', () => document.getElementById('fieldEditModal').classList.remove('open'));
    document.getElementById('fieldEditModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });

    // ── SUPPRESSION TOTALE D'UN PROFIL ──
    document.getElementById('pdDeleteBtn').addEventListener('click', () => {
      document.getElementById('deleteProfileConfirmInput').value = '';
      document.getElementById('deleteProfileConfirmBtn').disabled = true;
      document.getElementById('deleteProfileModal').classList.add('open');
    });
    document.getElementById('deleteProfileConfirmInput').addEventListener('input', function () {
      document.getElementById('deleteProfileConfirmBtn').disabled = this.value.trim() !== 'SUPPRIMER';
    });
    document.getElementById('deleteProfileCloseBtn').addEventListener('click', () => document.getElementById('deleteProfileModal').classList.remove('open'));
    document.getElementById('deleteProfileModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });

    document.getElementById('deleteProfileConfirmBtn').addEventListener('click', async function () {
      const btn = this;
      const sp = document.getElementById('deleteProfileSpinner');
      btn.disabled = true; sp.classList.add('active');
      try {
        const res = await apiFetch(`/api/admin/profiles/${encodeURIComponent(state.currentUid)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          showToast('Profil supprimé définitivement.', 'success');
          document.getElementById('deleteProfileModal').classList.remove('open');
          document.getElementById('dbProfileDetailWrap').style.display = 'none';
          document.getElementById('dbProfileListWrap').style.display = 'block';
          loadProfilesList(state.profilesPage);
        } else {
          showToast(data.error?.message || 'Erreur lors de la suppression.', 'error');
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') showToast('Erreur réseau.', 'error');
      } finally {
        btn.disabled = false; sp.classList.remove('active');
      }
    });
  })();