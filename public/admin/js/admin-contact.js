    // --
    const contactState = {
      page: 1, limit: 20, status: 'all', search: '',
      activeId: null, pendingFile: null, searchTimer: null,
    };

    const MEDIA_MAX_BYTES = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 100 * 1024 * 1024 };

    function contactMediaTypeFromMime(mime) {
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      return 'document';
    }

    function contactStatusLabel(status) {
      if (status === 'unread')  return 'Non lue';
      if (status === 'replied') return 'Répondue';
      return 'Lue';
    }

    function updateContactBadge(count) {
      [document.getElementById('contactUnreadBadge'), document.getElementById('contactUnreadBadgeMobile')].forEach(el => {
        if (!el) return;
        if (count > 0) { el.textContent = count > 99 ? '99+' : String(count); el.style.display = 'inline-flex'; }
        else { el.style.display = 'none'; }
      });
    }

    async function loadContactUnreadCount() {
      try {
        const res = await apiFetch('/api/admin/contact/unread-count');
        const data = await res.json();
        if (data.success) updateContactBadge(data.count);
      } catch (err) { /* silencieux — badge non bloquant */ }
    }

    async function loadContactMessages(page) {
      contactState.page = page || contactState.page;
      const scroll = document.getElementById('contactListScroll');
      scroll.innerHTML = '<div class="empty-state">Chargement...</div>';
      try {
        const params = new URLSearchParams({
          page: String(contactState.page), limit: String(contactState.limit), status: contactState.status,
        });
        if (contactState.search.trim()) params.set('search', contactState.search.trim());

        const res = await apiFetch('/api/admin/contact/messages?' + params.toString());
        const data = await res.json();
        if (!res.ok || !data.success) { scroll.innerHTML = '<div class="empty-state">Erreur de chargement.</div>'; return; }

        renderContactList(data.messages);

        const pag = document.getElementById('contactPagination');
        if (data.totalPages > 1) {
          pag.style.display = 'flex';
          document.getElementById('contactPaginationInfo').textContent = `Page ${data.page} sur ${data.totalPages}`;
          document.getElementById('contactPrevBtn').disabled = data.page <= 1;
          document.getElementById('contactNextBtn').disabled = data.page >= data.totalPages;
        } else {
          pag.style.display = 'none';
        }

        loadContactUnreadCount();
      } catch (err) {
        if (err.message !== 'Unauthorized') scroll.innerHTML = '<div class="empty-state">Erreur réseau.</div>';
      }
    }

    function renderContactList(messages) {
      const scroll = document.getElementById('contactListScroll');
      if (!messages.length) {
        scroll.innerHTML = '<div class="empty-state">Aucune demande trouvée.</div>';
        return;
      }
      scroll.innerHTML = messages.map(m => `
        <div class="contact-list-item ${contactState.activeId === m.id ? 'active' : ''}" data-id="${esc(m.id)}">
          <div class="avatar">${esc(initials(m.name))}</div>
          <div class="meta">
            <div class="row-top">
              <span class="name">${esc(m.name)}</span>
              <span class="time">${formatDate(m.createdAt)}</span>
            </div>
            <div class="subject">${esc(m.subject)}</div>
            <div class="preview">${esc(m.message)}</div>
            <span class="contact-status-chip ${esc(m.status)}">${esc(contactStatusLabel(m.status))}</span>
          </div>
          ${m.status === 'unread' ? '<span class="unread-dot"></span>' : ''}
        </div>
      `).join('');

      scroll.querySelectorAll('.contact-list-item').forEach(el => {
        el.addEventListener('click', () => openContactThread(el.dataset.id));
      });
    }

    async function openContactThread(id) {
      contactState.activeId = id;
      document.querySelectorAll('.contact-list-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === id);
      });

      try {
        const res = await apiFetch('/api/admin/contact/messages/' + encodeURIComponent(id));
        const data = await res.json();
        if (!res.ok || !data.success) { showToast(data.error?.message || 'Erreur de chargement de la conversation.', 'error'); return; }

        document.getElementById('contactThreadEmpty').style.display = 'none';
        const content = document.getElementById('contactThreadContent');
        content.style.display = 'flex';

        const msg = data.message;
        document.getElementById('contactThreadAvatar').textContent = initials(msg.name);
        document.getElementById('contactThreadName').textContent = msg.name;
        document.getElementById('contactThreadEmail').textContent = msg.email;
        document.getElementById('contactThreadPhone').textContent = msg.phone ? maskPhone(msg.phone) : 'Pas de téléphone';
        const chip = document.getElementById('contactThreadStatusChip');
        chip.textContent = contactStatusLabel(msg.status);
        chip.className = 'contact-status-chip ' + msg.status;

        renderContactThreadBody(msg, data.replies);

        // Marquer comme lu si nécessaire (silencieux)
        if (msg.status === 'unread') {
          apiFetch('/api/admin/contact/messages/' + encodeURIComponent(id) + '/read', { method: 'PATCH' })
            .then(() => { loadContactUnreadCount(); loadContactMessages(contactState.page); })
            .catch(() => {});
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') showToast('Erreur réseau.', 'error');
      }
    }

    function renderContactThreadBody(msg, replies) {
      const body = document.getElementById('contactThreadBody');
      let html = `
        <div class="contact-bubble inbound" style="max-width:65%;width:fit-content;padding:6px 10px;border-radius:8px;font-size:13px;line-height:1.4;background:#fff;color:#111b21;border:1px solid #e8ecef;border-top-left-radius:2px;align-self:flex-start;margin-bottom:2px;">
          <div class="bubble-label" style="font-size:11px;font-weight:700;color:#128C7E;margin-bottom:2px;">${esc(msg.name)} — ${esc(msg.subject)}</div>
          ${esc(msg.message)}
          <div class="bubble-time" style="font-size:10px;color:#8b969b;margin-top:2px;text-align:right;">${formatDate(msg.createdAt)}</div>
        </div>
      `;
      html += replies.map(r => {
        const mediaHtml = r.mediaType
          ? `<div class="bubble-media" style="display:flex;align-items:center;gap:4px;background:rgba(0,0,0,0.06);border-radius:6px;padding:4px 8px;margin-bottom:4px;font-size:12px;font-weight:600;color:#333;border:1px solid rgba(0,0,0,0.08);">📎 ${esc(r.mediaName || r.mediaType)}</div>`
          : '';
        const errorHtml = r.status === 'failed'
          ? `<div class="bubble-error" style="font-size:11px;color:#b91c1c;margin-top:3px;font-weight:600;">Échec de l'envoi${r.errorMessage ? ' — ' + esc(r.errorMessage) : ''}</div>`
          : '';
        const bgColor = r.status === 'failed' ? '#fee2e2' : '#d9fdd3';
        const border = r.status === 'failed' ? 'border:1px solid #fca5a5;' : '';
        return `
          <div class="contact-bubble outbound ${r.status === 'failed' ? 'failed' : ''}" style="max-width:65%;width:fit-content;padding:6px 10px;border-radius:8px;font-size:13px;line-height:1.4;background:${bgColor};color:#111b21;${border}border-top-right-radius:2px;align-self:flex-end;margin-bottom:2px;">
            <div class="bubble-label" style="font-size:11px;font-weight:700;color:#128C7E;margin-bottom:2px;">${esc(r.adminName || 'Administrateur')}</div>
            ${mediaHtml}
            ${r.body ? esc(r.body) : ''}
            <div class="bubble-time" style="font-size:10px;color:#8b969b;margin-top:2px;text-align:right;">${formatDate(r.createdAt)}</div>
            ${errorHtml}
          </div>
        `;
      }).join('');

      body.innerHTML = html;
      body.scrollTop = body.scrollHeight;
      
      // FORCER les styles immédiatement après le rendu
      setTimeout(() => {
        if (window.forceWhatsAppStyles) {
          window.forceWhatsAppStyles();
        }
      }, 100);
    }

    // ── Composer : pièce jointe ──
    const contactFileInput = document.getElementById('contactFileInput');
    document.getElementById('contactAttachBtn').addEventListener('click', () => contactFileInput.click());
    contactFileInput.addEventListener('change', () => {
      const file = contactFileInput.files[0];
      if (!file) return;
      const type = contactMediaTypeFromMime(file.type);
      const maxBytes = MEDIA_MAX_BYTES[type] || MEDIA_MAX_BYTES.document;
      if (file.size > maxBytes) {
        showToast(`Fichier trop volumineux (max ${Math.round(maxBytes / (1024 * 1024))} MB pour ce type).`, 'error');
        contactFileInput.value = '';
        return;
      }
      contactState.pendingFile = file;
      document.getElementById('contactAttachmentName').textContent = file.name;
      document.getElementById('contactAttachmentPreview').style.display = 'flex';
    });
    document.getElementById('contactAttachmentRemove').addEventListener('click', () => {
      contactState.pendingFile = null;
      contactFileInput.value = '';
      document.getElementById('contactAttachmentPreview').style.display = 'none';
    });

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result || '';
          const commaIdx = result.indexOf(',');
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
        reader.readAsDataURL(file);
      });
    }

    async function sendContactReply() {
      if (!contactState.activeId) return;
      const textarea = document.getElementById('contactReplyInput');
      const text = textarea.value.trim();
      const file  = contactState.pendingFile;

      if (!text && !file) { showToast('Écrivez un message ou joignez un fichier.', 'error'); return; }

      const sendBtn  = document.getElementById('contactSendBtn');
      const spinner  = document.getElementById('contactSendSpinner');
      const sendIcon = document.getElementById('contactSendIcon');
      sendBtn.disabled = true;
      spinner.classList.add('active');
      sendIcon.style.display = 'none';

      try {
        const payload = {};
        if (text) payload.message = text;
        if (file) {
          const base64 = await fileToBase64(file);
          payload.media = { type: contactMediaTypeFromMime(file.type), mime: file.type || 'application/octet-stream', name: file.name, base64 };
        }

        const res = await apiFetch('/api/admin/contact/messages/' + encodeURIComponent(contactState.activeId) + '/reply', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (res.ok && data.success) {
          textarea.value = '';
          contactState.pendingFile = null;
          contactFileInput.value = '';
          document.getElementById('contactAttachmentPreview').style.display = 'none';
          showToast('Réponse envoyée sur WhatsApp.', 'success');
          await openContactThread(contactState.activeId);
          loadContactMessages(contactState.page);
        } else {
          showToast(data.error?.message || "Erreur lors de l'envoi de la réponse.", 'error');
          if (data.reply) await openContactThread(contactState.activeId);
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') showToast('Erreur réseau lors de l\'envoi.', 'error');
      } finally {
        sendBtn.disabled = false;
        spinner.classList.remove('active');
        sendIcon.style.display = '';
      }
    }

    document.getElementById('contactSendBtn').addEventListener('click', sendContactReply);
    document.getElementById('contactReplyInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendContactReply(); }
    });
    document.getElementById('contactReplyInput').addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    // ── Recherche / filtre / pagination ──
    document.getElementById('contactSearchInput').addEventListener('input', function() {
      clearTimeout(contactState.searchTimer);
      contactState.searchTimer = setTimeout(() => {
        contactState.search = this.value;
        loadContactMessages(1);
      }, 350);
    });
    document.getElementById('contactFilterStatus').addEventListener('change', function() {
      contactState.status = this.value;
      loadContactMessages(1);
    });
    document.getElementById('contactPrevBtn').addEventListener('click', () => loadContactMessages(contactState.page - 1));
    document.getElementById('contactNextBtn').addEventListener('click', () => loadContactMessages(contactState.page + 1));
    document.getElementById('contactRefreshBtn').addEventListener('click', () => loadContactMessages(contactState.page));

    // ── Groupe WhatsApp admin ("Messagerie") ──
    const contactGroupState = { configured: false, connected: false, groupJid: null, name: '', participants: [] };

    function contactGroupStatusLabelText() {
      if (!contactGroupState.configured) return 'Configurer le groupe';
      if (!contactGroupState.connected) return 'Groupe configuré (hors ligne)';
      return contactGroupState.name || 'Gérer le groupe';
    }

    async function loadContactGroupStatus() {
      try {
        const res = await apiFetch('/api/admin/contact/group');
        const data = await res.json();
        if (!res.ok || !data.success) return;

        contactGroupState.configured   = !!data.configured;
        contactGroupState.connected    = !!data.connected;
        contactGroupState.groupJid     = data.groupJid || null;
        contactGroupState.name         = data.name || '';
        contactGroupState.participants = data.participants || [];

        document.getElementById('contactGroupStatusLabel').textContent = contactGroupStatusLabelText();
      } catch (err) { /* silencieux — non bloquant */ }
    }

    function renderContactGroupParticipants() {
      const list = document.getElementById('contactGroupParticipantsList');
      document.getElementById('contactGroupParticipantsCount').textContent = contactGroupState.participants.length;
      if (!contactGroupState.participants.length) {
        list.innerHTML = '<div style="padding:0.75rem;font-size:0.8125rem;color:#9aa5ab;">Aucun participant.</div>';
        return;
      }
      list.innerHTML = contactGroupState.participants.map(p => {
        const phone = (p.jid || '').split('@')[0];
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem 0.75rem;border-bottom:1px solid #f4f5f6;font-size:0.8125rem;">
            <span>${esc(maskPhone(phone))} ${p.isAdmin ? '<strong style="color:#128C7E;">(admin)</strong>' : ''}</span>
            ${p.isAdmin ? '' : `<button type="button" class="contact-composer-attachment" data-remove-jid="${esc(p.jid)}" style="border:none;background:none;color:#dc3545;cursor:pointer;font-weight:700;padding:0;">Retirer</button>`}
          </div>
        `;
      }).join('');

      list.querySelectorAll('[data-remove-jid]').forEach(btn => {
        btn.addEventListener('click', () => removeContactGroupParticipant(btn.dataset.removeJid));
      });
    }

    function openContactGroupModal() {
      const createForm = document.getElementById('contactGroupCreateForm');
      const manage      = document.getElementById('contactGroupManage');
      const submitBtn   = document.getElementById('contactGroupSubmitBtn');
      document.getElementById('contactGroupCreateError').style.display = 'none';
      document.getElementById('contactGroupManageError').style.display = 'none';

      if (!contactGroupState.configured) {
        createForm.style.display = 'block';
        manage.style.display = 'none';
        submitBtn.style.display = 'flex';
        document.getElementById('contactGroupSubmitLabel').textContent = 'Créer le groupe';
        document.getElementById('contactGroupNameInput').value = '';
        // Initialiser la liste de phones avec une premiere ligne vide
        initPhoneList('contactGroupPhoneList', 'contactGroupAddPhoneBtn');
      } else {
        createForm.style.display = 'none';
        manage.style.display = 'block';
        submitBtn.style.display = 'none';
        document.getElementById('contactGroupRenameInput').value = contactGroupState.name || '';
        // Initialiser la liste d'ajout de phones
        initPhoneList('contactGroupAddPhoneList', 'contactGroupAddMorePhoneBtn');
        renderContactGroupParticipants();
      }
      document.getElementById('contactGroupModal').classList.add('open');
    }
    function closeContactGroupModal() { document.getElementById('contactGroupModal').classList.remove('open'); }

    document.getElementById('contactGroupStatusBtn').addEventListener('click', openContactGroupModal);
    document.getElementById('contactGroupModalClose').addEventListener('click', closeContactGroupModal);
    document.getElementById('contactGroupModal').addEventListener('click', (e) => {
      if (e.target.id === 'contactGroupModal') closeContactGroupModal();
    });

    // ── Utilitaire : créer une ligne de saisie numéro avec sélecteur d'indicatif ──
    // Pays disponibles avec indicatifs et formats de placeholder
    const PHONE_COUNTRIES = [
      { code: '+229', flag: 'BJ', label: 'Bénin (+229)',      placeholder: '94 00 00 00' },
      { code: '+225', flag: 'CI', label: 'Côte d\'Ivoire (+225)', placeholder: '07 00 00 00 00' },
      { code: '+221', flag: 'SN', label: 'Sénégal (+221)',    placeholder: '77 000 00 00' },
      { code: '+226', flag: 'BF', label: 'Burkina Faso (+226)', placeholder: '70 00 00 00' },
      { code: '+227', flag: 'NE', label: 'Niger (+227)',       placeholder: '90 00 00 00' },
      { code: '+228', flag: 'TG', label: 'Togo (+228)',        placeholder: '90 00 00 00' },
      { code: '+237', flag: 'CM', label: 'Cameroun (+237)',    placeholder: '6 00 00 00 00' },
      { code: '+224', flag: 'GN', label: 'Guinée (+224)',      placeholder: '620 00 00 00' },
      { code: '+223', flag: 'ML', label: 'Mali (+223)',        placeholder: '70 00 00 00' },
      { code: '+212', flag: 'MA', label: 'Maroc (+212)',       placeholder: '6 00 00 00 00' },
      { code: '+33',  flag: 'FR', label: 'France (+33)',       placeholder: '6 00 00 00 00' },
      { code: '+32',  flag: 'BE', label: 'Belgique (+32)',     placeholder: '470 00 00 00' },
      { code: '+1',   flag: 'US', label: 'USA/Canada (+1)',    placeholder: '555 000 0000' },
      { code: '+44',  flag: 'GB', label: 'Royaume-Uni (+44)', placeholder: '7700 000000' },
    ];
    const DEFAULT_COUNTRY = PHONE_COUNTRIES[0]; // +229 Bénin

    function buildPhoneRowHtml(listId, rowId) {
      const opts = PHONE_COUNTRIES.map(c =>
        `<option value="${c.code}" ${c === DEFAULT_COUNTRY ? 'selected' : ''}>${c.label}</option>`
      ).join('');
      return `<div id="${rowId}" style="display:flex;gap:0.4rem;align-items:center;">
        <select data-phone-country style="border:1px solid #ddd;border-radius:8px;padding:0.4rem 0.5rem;font-size:0.8rem;font-family:'Inter',sans-serif;background:#fff;flex-shrink:0;max-width:175px;">
          ${opts}
        </select>
        <input type="tel" data-phone-number style="flex:1;border:1px solid #ddd;border-radius:8px;padding:0.45rem 0.7rem;font-size:0.8rem;font-family:'Inter',sans-serif;" placeholder="${DEFAULT_COUNTRY.placeholder}" />
        <button type="button" data-remove-row="${rowId}" style="border:none;background:none;color:#dc3545;cursor:pointer;font-size:1.1rem;padding:0.2rem;flex-shrink:0;" title="Supprimer">x</button>
      </div>`;
    }

    function initPhoneList(listId, addBtnId) {
      const list = document.getElementById(listId);
      const addBtn = document.getElementById(addBtnId);
      if (!list || !addBtn) return;

      // Vider et ajouter une première ligne
      list.innerHTML = '';
      _addPhoneRow(list);

      addBtn.onclick = () => _addPhoneRow(list);

      // Délégation : mise à jour du placeholder quand l'indicatif change
      list.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-phone-country]');
        if (!sel) return;
        const country = PHONE_COUNTRIES.find(c => c.code === sel.value) || DEFAULT_COUNTRY;
        const row = sel.closest('div');
        const input = row?.querySelector('[data-phone-number]');
        if (input) input.placeholder = country.placeholder;
      });

      // Délégation : suppression d'une ligne
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove-row]');
        if (!btn) return;
        const rowId = btn.dataset.removeRow;
        const row = document.getElementById(rowId);
        if (row && list.children.length > 1) row.remove();
      });
    }

    let _phoneRowCounter = 0;
    function _addPhoneRow(listEl) {
      const rowId = 'phone-row-' + (++_phoneRowCounter);
      listEl.insertAdjacentHTML('beforeend', buildPhoneRowHtml(listEl.id, rowId));
    }

    function collectPhoneList(listId) {
      const list = document.getElementById(listId);
      if (!list) return [];
      const results = [];
      list.querySelectorAll('div[id^="phone-row-"]').forEach(row => {
        const sel = row.querySelector('[data-phone-country]');
        const inp = row.querySelector('[data-phone-number]');
        if (!sel || !inp) return;
        const raw = inp.value.trim();
        if (!raw) return;
        // Nettoyer : retirer espaces, tirets, parenthèses
        const clean = raw.replace(/[\s\-().]/g, '');
        const dialCode = sel.value.replace('+', '');
        // Eviter de doubler l'indicatif si l'utilisateur l'a déjà saisi
        const number = clean.startsWith(dialCode) ? clean : dialCode + clean;
        results.push(number);
      });
      return results;
    }

    document.getElementById('contactGroupSubmitBtn').addEventListener('click', async () => {
      const name = document.getElementById('contactGroupNameInput').value.trim();
      const participants = collectPhoneList('contactGroupPhoneList');
      const errorEl = document.getElementById('contactGroupCreateError');
      errorEl.style.display = 'none';

      if (!name) { errorEl.textContent = 'Le nom du groupe est requis.'; errorEl.style.display = 'block'; return; }
      if (!participants.length) { errorEl.textContent = 'Ajoutez au moins un numéro WhatsApp.'; errorEl.style.display = 'block'; return; }

      const btn = document.getElementById('contactGroupSubmitBtn');
      const spinner = document.getElementById('contactGroupSpinner');
      btn.disabled = true;
      spinner.classList.add('active');
      try {
        const res = await apiFetch('/api/admin/contact/group', { method: 'POST', body: JSON.stringify({ name, participants }) });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Groupe créé avec succès.', 'success');
          closeContactGroupModal();
          await loadContactGroupStatus();
        } else {
          errorEl.textContent = data.error?.message || 'Erreur lors de la création du groupe.';
          errorEl.style.display = 'block';
        }
      } catch (err) {
        errorEl.textContent = 'Erreur réseau.';
        errorEl.style.display = 'block';
      } finally {
        btn.disabled = false;
        spinner.classList.remove('active');
      }
    });

    document.getElementById('contactGroupRenameBtn').addEventListener('click', async () => {
      const name = document.getElementById('contactGroupRenameInput').value.trim();
      const errorEl = document.getElementById('contactGroupManageError');
      errorEl.style.display = 'none';
      if (!name) { errorEl.textContent = 'Le nom du groupe est requis.'; errorEl.style.display = 'block'; return; }

      try {
        const res = await apiFetch('/api/admin/contact/group', { method: 'PATCH', body: JSON.stringify({ name }) });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Groupe renommé.', 'success');
          await loadContactGroupStatus();
        } else {
          errorEl.textContent = data.error?.message || 'Erreur lors du renommage.';
          errorEl.style.display = 'block';
        }
      } catch (err) {
        errorEl.textContent = 'Erreur réseau.';
        errorEl.style.display = 'block';
      }
    });

    document.getElementById('contactGroupAddBtn').addEventListener('click', async () => {
      const participants = collectPhoneList('contactGroupAddPhoneList');
      const errorEl = document.getElementById('contactGroupManageError');
      errorEl.style.display = 'none';
      if (!participants.length) { errorEl.textContent = 'Indiquez au moins un numéro.'; errorEl.style.display = 'block'; return; }

      try {
        const res = await apiFetch('/api/admin/contact/group/participants', { method: 'POST', body: JSON.stringify({ participants }) });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Membre(s) ajouté(s).', 'success');
          initPhoneList('contactGroupAddPhoneList', 'contactGroupAddMorePhoneBtn');
          await loadContactGroupStatus();
          renderContactGroupParticipants();
        } else {
          errorEl.textContent = data.error?.message || "Erreur lors de l'ajout.";
          errorEl.style.display = 'block';
        }
      } catch (err) {
        errorEl.textContent = 'Erreur réseau.';
        errorEl.style.display = 'block';
      }
    });

    async function removeContactGroupParticipant(jid) {
      if (!confirm('Retirer ce membre du groupe ?')) return;
      const errorEl = document.getElementById('contactGroupManageError');
      errorEl.style.display = 'none';
      try {
        const res = await apiFetch('/api/admin/contact/group/participants', { method: 'DELETE', body: JSON.stringify({ participants: [jid] }) });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Membre retiré.', 'success');
          await loadContactGroupStatus();
          renderContactGroupParticipants();
        } else {
          errorEl.textContent = data.error?.message || 'Erreur lors du retrait.';
          errorEl.style.display = 'block';
        }
      } catch (err) {
        errorEl.textContent = 'Erreur réseau.';
        errorEl.style.display = 'block';
      }
    }

    document.getElementById('contactGroupInviteBtn').addEventListener('click', async () => {
      try {
        const res = await apiFetch('/api/admin/contact/group/invite-code');
        const data = await res.json();
        if (res.ok && data.success && data.inviteLink) {
          await navigator.clipboard.writeText(data.inviteLink).catch(() => {});
          showToast('Lien d\'invitation copié dans le presse-papiers.', 'success');
        } else {
          showToast(data.error?.message || "Impossible de récupérer le lien d'invitation.", 'error');
        }
      } catch (err) {
        showToast('Erreur réseau.', 'error');
      }
    });
