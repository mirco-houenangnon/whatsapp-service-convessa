    const newPlanModal      = document.getElementById('newPlanModal');
    const newPlanForm       = document.getElementById('newPlanForm');
    const planUsageFields   = document.getElementById('planUsageFields');
    const planUsageValue    = document.getElementById('planUsageValue');
    const planUsageValueLbl = document.getElementById('planUsageValueLabel');

    function openNewPlanModal() {
      newPlanForm.reset();
      planUsageFields.classList.remove('visible');
      planUsageValueLbl.textContent = 'Durée (en jours)';
      newPlanModal.classList.add('open');
    }
    function closeNewPlanModal() { newPlanModal.classList.remove('open'); }

    document.getElementById('newPlanBtn').addEventListener('click', openNewPlanModal);
    document.getElementById('newPlanCloseBtn').addEventListener('click', closeNewPlanModal);
    newPlanModal.addEventListener('click', (e) => { if (e.target === newPlanModal) closeNewPlanModal(); });

    document.getElementsByName('planUnlimited').forEach(radio => {
      radio.addEventListener('change', function() {
        planUsageFields.classList.toggle('visible', this.value === 'no');
      });
    });
    document.getElementsByName('planUsageType').forEach(radio => {
      radio.addEventListener('change', function() {
        planUsageValueLbl.textContent = this.value === 'duration' ? 'Durée (en jours)' : 'Nombre de requêtes';
      });
    });

    newPlanForm.addEventListener('submit', async function(e) {
      e.preventDefault();

      const name      = document.getElementById('planNameInput').value.trim();
      const price     = parseInt(document.getElementById('planPriceInput').value, 10);
      const unlimited = document.querySelector('input[name="planUnlimited"]:checked').value === 'yes';

      if (!name) {
        showToast('Le nom du plan est requis.', 'error');
        return;
      }
      if (!Number.isInteger(price) || price < 0 || price > 1000000) {
        showToast('Le prix doit être compris entre 0 et 1 000 000 Frs CFA.', 'error');
        return;
      }

      const payload = { name, price, unlimited };
      if (!unlimited) {
        const usageType = document.querySelector('input[name="planUsageType"]:checked').value;
        const value = parseInt(planUsageValue.value, 10);
        if (!Number.isInteger(value) || value < 1) {
          showToast('Veuillez préciser une valeur valide (nombre entier positif).', 'error');
          return;
        }
        payload.usageType  = usageType;
        payload.usageValue = value;
      }

      const btn = document.getElementById('savePlanBtn');
      const sp  = document.getElementById('spinnerPlan');
      btn.disabled = true;
      sp.classList.add('active');
      try {
        const res  = await apiFetch('/api/admin/plans', { method: 'POST', body: JSON.stringify(payload) });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Plan créé avec succès.', 'success');
          closeNewPlanModal();
          await loadPlans();
        } else {
          showToast(data.error?.message || 'Erreur lors de la création du plan.', 'error');
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') showToast('Erreur réseau.', 'error');
      } finally {
        btn.disabled = false;
        sp.classList.remove('active');
      }
    });

    // ── TAB SWITCHING ──