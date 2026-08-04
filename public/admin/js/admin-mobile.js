// ── SUSPENSION / RÉACTIVATION TENANT ────────────────────────────────────────
(function() {
  let _suspendTenantId = null;

  window.openSuspendModal = function(tenantId, tenantName) {
    _suspendTenantId = tenantId;
    document.getElementById('suspendModalTitle').textContent =
      'Suspendre : ' + (tenantName || tenantId.slice(0, 8) + '…');
    document.getElementById('suspendReason').value = '';
    document.getElementById('suspendError').style.display = 'none';
    document.getElementById('suspendModal').classList.add('open');
    setTimeout(() => document.getElementById('suspendReason').focus(), 100);
  };

  window.closeSuspendModal = function() {
    document.getElementById('suspendModal').classList.remove('open');
    _suspendTenantId = null;
  };

  document.getElementById('suspendModal').addEventListener('click', function(e) {
    if (e.target === this) window.closeSuspendModal();
  });

  window.confirmSuspend = async function() {
    if (!_suspendTenantId) return;
    const reason = document.getElementById('suspendReason').value.trim();
    const errEl  = document.getElementById('suspendError');
    const btn    = document.getElementById('suspendConfirmBtn');

    if (!reason) {
      errEl.textContent = 'La raison de suspension est obligatoire.';
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    errEl.style.display = 'none';

    try {
      const token = sessionStorage.getItem('admin_token') || '';
      const res = await fetch('/api/admin/tenants/' + _suspendTenantId + '/suspend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        credentials: 'same-origin',
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error?.message || 'Erreur');

      window.closeSuspendModal();
      // Rafraîchir la liste des tenants
      if (typeof loadTenants === 'function') loadTenants();
      if (typeof showToast === 'function') showToast('Compte suspendu. Le tenant a été notifié via WhatsApp.', 'success');
    } catch (e) {
      errEl.textContent = e.message || 'Erreur lors de la suspension.';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  };

  window.unsuspendTenant = async function(tenantId) {
    if (!confirm('Réactiver ce compte WhatsApp ?')) return;
    try {
      const token = sessionStorage.getItem('admin_token') || '';
      const res = await fetch('/api/admin/tenants/' + tenantId + '/unsuspend', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error?.message || 'Erreur');
      if (typeof loadTenants === 'function') loadTenants();
      if (typeof showToast === 'function') showToast('Compte réactivé avec succès.', 'success');
    } catch (e) {
      if (typeof showToast === 'function') showToast(e.message || 'Erreur lors de la réactivation.', 'error');
    }
  };
})();