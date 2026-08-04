    // ── LOAD USERS ──
    let currentUsersPage = 1;
    let currentUsersLimit = 20;
    let allUsersData = null;

    async function loadUsers(page = 1, limit = 20) {
      currentUsersPage = page;
      currentUsersLimit = limit;

      const tbody = document.getElementById('usersTableBody');
      const pagination = document.getElementById('usersPagination');
      const prevBtn = document.getElementById('usersPrevBtn');
      const nextBtn = document.getElementById('usersNextBtn');
      const paginationInfo = document.getElementById('usersPaginationInfo');

      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Chargement des utilisateurs...</div></td></tr>';
      pagination.style.display = 'none';

      try {
        const res = await apiFetch(`/api/admin/users?page=${page}&limit=${limit}`);
        const data = await res.json();

        if (data.success && Array.isArray(data.data) && data.data.length > 0) {
          allUsersData = data;

          // Calculer les stats
          const total = data.meta.total;
          const active = data.data.filter(u => u.active).length;
          const inactive = total - active;
          
          // Calculer nouveaux ce mois (approximation - créés dans les 30 derniers jours)
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          const newThisMonth = data.data.filter(u => new Date(u.created_at) > thirtyDaysAgo).length;

          // Mettre à jour les stats
          document.getElementById('statUsersTotal').textContent = total;
          document.getElementById('statUsersActive').textContent = active;
          document.getElementById('statUsersInactive').textContent = inactive;
          document.getElementById('statUsersNewMonth').textContent = newThisMonth;

          // Générer les lignes du tableau
          tbody.innerHTML = data.data.map(user => {
            const initial = (user.display_name || user.email || '?')[0].toUpperCase();
            const displayName = user.display_name || 'Utilisateur';
            const userId = user.firebase_uid ? user.firebase_uid.substring(0, 8) : user.id;
            const email = user.email || '—';
            const phone = user.phone ? maskPhone(user.phone) : '—';
            const statusClass = user.active ? 'active' : 'inactive';
            const statusLabel = user.active ? 'Actif' : 'Inactif';
            const statusIcon = user.active 
              ? '<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>'
              : '<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>';

            const createdDate = formatDate(user.created_at);
            const lastLogin = user.last_login ? formatDate(user.last_login) : '<span style="color:#9ca3af;">Jamais</span>';

            return `
              <tr>
                <td>
                  <div class="user-info-cell">
                    <div class="user-avatar-table">${initial}</div>
                    <div class="user-details">
                      <div class="user-name">${esc(displayName)}</div>
                      <div class="user-id">ID: ${esc(userId)}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="contact-info">
                    <div class="contact-item">
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                      </svg>
                      ${esc(email)}
                    </div>
                    <div class="contact-item">
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
                      </svg>
                      ${esc(phone)}
                    </div>
                  </div>
                </td>
                <td>
                  <span class="user-badge ${statusClass}">
                    ${statusIcon}
                    ${statusLabel}
                  </span>
                </td>
                <td>
                  <div class="date-display">${createdDate}</div>
                </td>
                <td>
                  <div class="date-display">${lastLogin}</div>
                </td>
              </tr>
            `;
          }).join('');

          // Gérer la pagination
          const { page: currentPage, pages: totalPages } = data.meta;
          paginationInfo.textContent = `Page ${currentPage} sur ${totalPages}`;
          prevBtn.disabled = currentPage <= 1;
          nextBtn.disabled = currentPage >= totalPages;
          pagination.style.display = 'flex';

        } else {
          tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><svg width="36" height="36" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="#e4e6ea" stroke-width="2"/><circle cx="9" cy="7" r="4" stroke="#e4e6ea" stroke-width="2"/></svg>Aucun utilisateur trouvé.</div></td></tr>';
          
          // Stats à 0
          document.getElementById('statUsersTotal').textContent = '0';
          document.getElementById('statUsersActive').textContent = '0';
          document.getElementById('statUsersInactive').textContent = '0';
          document.getElementById('statUsersNewMonth').textContent = '0';
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') {
          tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state" style="color:#dc3545;">Erreur lors du chargement des utilisateurs.</div></td></tr>';
        }
      }
    }

    // Pagination buttons
    document.getElementById('usersPrevBtn').addEventListener('click', () => {
      if (currentUsersPage > 1) {
        loadUsers(currentUsersPage - 1, currentUsersLimit);
      }
    });

    document.getElementById('usersNextBtn').addEventListener('click', () => {
      if (allUsersData && currentUsersPage < allUsersData.meta.pages) {
        loadUsers(currentUsersPage + 1, currentUsersLimit);
      }
    });

    // Recherche et filtres
    let searchTimeout;
    document.getElementById('userSearchInput').addEventListener('input', function(e) {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        filterUsersTable(e.target.value, document.getElementById('userFilterStatus').value);
      }, 300);
    });

    document.getElementById('userFilterStatus').addEventListener('change', function(e) {
      filterUsersTable(document.getElementById('userSearchInput').value, e.target.value);
    });

    function filterUsersTable(searchTerm, statusFilter) {
      if (!allUsersData || !allUsersData.data) return;

      const tbody = document.getElementById('usersTableBody');
      const searchLower = searchTerm.toLowerCase().trim();

      const filteredUsers = allUsersData.data.filter(user => {
        // Filtre de recherche
        const matchSearch = !searchLower || 
          (user.email && user.email.toLowerCase().includes(searchLower)) ||
          (user.phone && user.phone.includes(searchLower)) ||
          (user.display_name && user.display_name.toLowerCase().includes(searchLower));

        // Filtre de statut
        const matchStatus = statusFilter === 'all' ||
          (statusFilter === 'active' && user.active) ||
          (statusFilter === 'inactive' && !user.active);

        return matchSearch && matchStatus;
      });

      if (filteredUsers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Aucun utilisateur ne correspond aux critères.</div></td></tr>';
        return;
      }

      // Régénérer le tableau avec les résultats filtrés
      tbody.innerHTML = filteredUsers.map(user => {
        const initial = (user.display_name || user.email || '?')[0].toUpperCase();
        const displayName = user.display_name || 'Utilisateur';
        const userId = user.firebase_uid ? user.firebase_uid.substring(0, 8) : user.id;
        const email = user.email || '—';
        const phone = user.phone ? maskPhone(user.phone) : '—';
        const statusClass = user.active ? 'active' : 'inactive';
        const statusLabel = user.active ? 'Actif' : 'Inactif';
        const statusIcon = user.active 
          ? '<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>'
          : '<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>';

        const createdDate = formatDate(user.created_at);
        const lastLogin = user.last_login ? formatDate(user.last_login) : '<span style="color:#9ca3af;">Jamais</span>';

        return `
          <tr>
            <td>
              <div class="user-info-cell">
                <div class="user-avatar-table">${initial}</div>
                <div class="user-details">
                  <div class="user-name">${esc(displayName)}</div>
                  <div class="user-id">ID: ${esc(userId)}</div>
                </div>
              </div>
            </td>
            <td>
              <div class="contact-info">
                <div class="contact-item">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                  </svg>
                  ${esc(email)}
                </div>
                <div class="contact-item">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
                  </svg>
                  ${esc(phone)}
                </div>
              </div>
            </td>
            <td>
              <span class="user-badge ${statusClass}">
                ${statusIcon}
                ${statusLabel}
              </span>
            </td>
            <td>
              <div class="date-display">${createdDate}</div>
            </td>
            <td>
              <div class="date-display">${lastLogin}</div>
            </td>
          </tr>
        `;
      }).join('');
    }

    // ── MODAL: NOUVEAU CODE DE PARRAINAGE ──