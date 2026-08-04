    const newCodeModal      = document.getElementById('newCodeModal');
    const newCodeForm       = document.getElementById('newCodeForm');
    const codeUsageFields   = document.getElementById('codeUsageFields');
    const codeUsageValue    = document.getElementById('codeUsageValue');
    const codeUsageValueLbl = document.getElementById('codeUsageValueLabel');

    function openNewCodeModal() {
      newCodeForm.reset();
      codeUsageFields.classList.remove('visible');
      codeUsageValueLbl.textContent = 'Durée (en jours)';
      newCodeModal.classList.add('open');
    }
    function closeNewCodeModal() { newCodeModal.classList.remove('open'); }

    document.getElementById('newCodeBtn').addEventListener('click', openNewCodeModal);
    document.getElementById('newCodeCloseBtn').addEventListener('click', closeNewCodeModal);
    newCodeModal.addEventListener('click', (e) => { if (e.target === newCodeModal) closeNewCodeModal(); });

    document.getElementsByName('codeUnlimited').forEach(radio => {
      radio.addEventListener('change', function() {
        codeUsageFields.classList.toggle('visible', this.value === 'no');
      });
    });
    document.getElementsByName('codeUsageType').forEach(radio => {
      radio.addEventListener('change', function() {
        codeUsageValueLbl.textContent = this.value === 'duration' ? 'Durée (en jours)' : 'Nombre de requêtes';
      });
    });

    newCodeForm.addEventListener('submit', async function(e) {
      e.preventDefault();

      const code      = document.getElementById('codeInput').value.trim();
      const unlimited = document.querySelector('input[name="codeUnlimited"]:checked').value === 'yes';

      if (code.length < 4 || code.length > 12) {
        showToast('Le code doit contenir entre 4 et 12 caractères.', 'error');
        return;
      }

      const payload = { code, unlimited };
      if (!unlimited) {
        const usageType = document.querySelector('input[name="codeUsageType"]:checked').value;
        const value = parseInt(codeUsageValue.value, 10);
        if (!Number.isInteger(value) || value < 1) {
          showToast('Veuillez préciser une valeur valide (nombre entier positif).', 'error');
          return;
        }
        payload.usageType  = usageType;
        payload.usageValue = value;
      }

      const btn = document.getElementById('saveCodeBtn');
      const sp  = document.getElementById('spinnerCode');
      btn.disabled = true;
      sp.classList.add('active');
      try {
        const res  = await apiFetch('/api/admin/referral-codes', { method: 'POST', body: JSON.stringify(payload) });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Code de parrainage créé avec succès.', 'success');
          closeNewCodeModal();
          await loadReferralCodes();
        } else {
          showToast(data.error?.message || 'Erreur lors de la création du code.', 'error');
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') showToast('Erreur réseau.', 'error');
      } finally {
        btn.disabled = false;
        sp.classList.remove('active');
      }
    });

    // ── MODAL: NOUVEAU PLAN D'ABONNEMENT ──