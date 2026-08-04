    // ── INIT ──
    // Ce script est chargé en dernier afin que toutes les fonctions définies
    // dans les autres modules (admin-contact.js, admin-users.js, etc.) soient
    // disponibles au moment où activateTab() est appelé.
    (async function init() {
      // Restaurer l'onglet IMMÉDIATEMENT — avant tout chargement async —
      // pour éviter le flash du dashboard par défaut lors d'un F5.
      const savedTab = sessionStorage.getItem(ACTIVE_TAB_KEY) || 'dashboard';
      activateTab(savedTab, { persist: false });
      // Synchroniser l'état actif dans le drawer mobile
      document.querySelectorAll('.mobile-nav-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === savedTab);
      });

      await loadProfile();
      await Promise.all([loadStats(), loadTenants()]);
      loadContactUnreadCount();
    })();
