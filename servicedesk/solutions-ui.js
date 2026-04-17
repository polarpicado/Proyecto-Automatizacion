const SOLUTIONS_API_BASE_URL = window.SERVICEDESK_CONFIG?.apiBaseUrl || 'https://caritive-corrosively-natalia.ngrok-free.dev/api';

(() => {
    const view = document.getElementById('view-solutions');
    if (!view) return;

    const treeEl = document.getElementById('solutions-folders');
    const listEl = document.getElementById('solutions-list');
    const searchEl = document.getElementById('solutions-search');
    const formEl = document.getElementById('solution-form');
    const newButton = document.getElementById('solutions-new-btn');
    const resetButton = document.getElementById('solutions-reset-btn');
    const cancelButton = document.getElementById('solution-cancel-btn');
    const deleteButton = document.getElementById('solution-delete-btn');
    const titleEl = document.getElementById('s-titulo');
    const folderEl = document.getElementById('s-carpeta');
    const createdAtEl = document.getElementById('solution-created-at');
    const updatedAtEl = document.getElementById('solution-updated-at');
    const formTitleEl = document.getElementById('solution-form-title');
    const formSubtitleEl = document.getElementById('solution-form-subtitle');
    const navSolutions = document.getElementById('nav-soluciones-link');
    const descriptionQuill = window.solutionDescriptionQuill || solutionDescriptionQuill;

    let items = [];
    let selectedId = null;
    let selectedPath = '';

    function api(path) {
        return `${SOLUTIONS_API_BASE_URL}${path}`;
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function stripHtml(value) {
        const div = document.createElement('div');
        div.innerHTML = value || '';
        return (div.textContent || div.innerText || '').trim();
    }

    function getErrorMessage(detail, fallback) {
        if (!detail) return fallback;
        if (typeof detail === 'string') return detail;
        if (Array.isArray(detail)) {
            const firstMessage = detail
                .map((item) => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item.msg === 'string') return item.msg;
                    return '';
                })
                .find(Boolean);
            return firstMessage || fallback;
        }
        if (typeof detail === 'object' && typeof detail.msg === 'string') {
            return detail.msg;
        }
        return fallback;
    }

    function formatDate(value, withTime = false) {
        if (!value) return '--';
        const date = new Date(value);
        const options = withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' };
        return new Intl.DateTimeFormat('es-PE', options).format(date);
    }

    function showMeta(createdAt, updatedAt) {
        createdAtEl.innerText = `Creado: ${formatDate(createdAt, true)}`;
        updatedAtEl.innerText = `Última modificación: ${formatDate(updatedAt, true)}`;
        createdAtEl.classList.remove('hidden');
        updatedAtEl.classList.remove('hidden');
    }

    function hideMeta() {
        createdAtEl.classList.add('hidden');
        updatedAtEl.classList.add('hidden');
        createdAtEl.innerText = '';
        updatedAtEl.innerText = '';
    }

    function resetForm() {
        selectedId = null;
        formEl.reset();
        descriptionQuill.setContents([]);
        formTitleEl.innerText = 'Nueva solución';
        formSubtitleEl.innerText = selectedPath ? `Nueva página dentro de ${selectedPath}` : 'Crea una página nueva o edita una existente.';
        deleteButton.classList.add('hidden');
        resetButton.classList.add('hidden');
        hideMeta();
        folderEl.value = selectedPath;
        titleEl.focus();
    }

    async function ensureHomePage() {
        if (items.length > 0) return;
        const response = await fetch(api('/solutions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                carpeta: '',
                titulo: 'Inicio',
                descripcion_html: '<p>Bienvenido a la base de conocimientos. Aquí puedes documentar soluciones importantes del equipo.</p>'
            })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(getErrorMessage(data.detail, 'No se pudo crear la página inicial.'));
        }
    }

    function buildTree() {
        const root = { folders: new Map(), pages: [] };
        for (const item of items) {
            const rawPath = String(item.carpeta || '').trim();
            const parts = rawPath ? rawPath.split('/').map((part) => part.trim()).filter(Boolean) : [];
            let cursor = root;
            let currentPath = '';
            for (const part of parts) {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                if (!cursor.folders.has(part)) {
                    cursor.folders.set(part, { name: part, path: currentPath, folders: new Map(), pages: [] });
                }
                cursor = cursor.folders.get(part);
            }
            cursor.pages.push(item);
        }
        return root;
    }

    function renderPageNode(item, depth) {
        const selectedClass = item._id === selectedId ? 'active' : '';
        return `
            <button type="button" class="tree-page ${selectedClass}" data-page-id="${item._id}" style="--depth:${depth}">
                <span class="tree-icon"><i class="fa-regular fa-file-lines"></i></span>
                <span class="tree-label">${escapeHtml(item.titulo)}</span>
            </button>
        `;
    }

    function renderFolderNode(node, depth) {
        const childFolders = Array.from(node.folders.values())
            .sort((a, b) => a.name.localeCompare(b.name, 'es'))
            .map((child) => renderFolderNode(child, depth + 1))
            .join('');
        const pages = node.pages
            .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'))
            .map((item) => renderPageNode(item, depth + 1))
            .join('');

        return `
            <div class="tree-folder" style="--depth:${depth}">
                <div class="tree-folder-row">
                    <button type="button" class="tree-folder-label" data-folder-path="${escapeHtml(node.path)}">
                        <span class="tree-icon"><i class="fa-regular fa-folder-open"></i></span>
                        <span>${escapeHtml(node.name)}</span>
                    </button>
                    <button type="button" class="tree-add-btn" data-add-page="${escapeHtml(node.path)}">+</button>
                </div>
                <div class="tree-children">
                    ${pages}
                    ${childFolders}
                </div>
            </div>
        `;
    }

    function bindTreeEvents() {
        treeEl.querySelectorAll('[data-page-id]').forEach((button) => {
            button.onclick = async () => {
                await openPage(button.dataset.pageId);
            };
        });

        treeEl.querySelectorAll('[data-add-page]').forEach((button) => {
            button.onclick = (event) => {
                event.stopPropagation();
                selectedPath = button.dataset.addPage || '';
                resetForm();
            };
        });

        treeEl.querySelectorAll('[data-folder-path]').forEach((button) => {
            button.onclick = () => {
                selectedPath = button.dataset.folderPath || '';
                if (!selectedId) {
                    resetForm();
                } else {
                    renderTree();
                }
            };
        });
    }

    function renderTree() {
        const term = searchEl.value.trim().toLowerCase();
        const visibleItems = term
            ? items.filter((item) => [item.titulo, item.carpeta, stripHtml(item.descripcion_html || '')].join(' ').toLowerCase().includes(term))
            : items;

        const addRootClass = !selectedPath ? 'active' : '';
        const tree = { folders: new Map(), pages: [] };
        for (const item of visibleItems) {
            const rawPath = String(item.carpeta || '').trim();
            const parts = rawPath ? rawPath.split('/').map((part) => part.trim()).filter(Boolean) : [];
            let cursor = tree;
            let currentPath = '';
            for (const part of parts) {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                if (!cursor.folders.has(part)) {
                    cursor.folders.set(part, { name: part, path: currentPath, folders: new Map(), pages: [] });
                }
                cursor = cursor.folders.get(part);
            }
            cursor.pages.push(item);
        }

        const rootPages = tree.pages
            .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'))
            .map((item) => renderPageNode(item, 0))
            .join('');

        const folderNodes = Array.from(tree.folders.values())
            .sort((a, b) => a.name.localeCompare(b.name, 'es'))
            .map((node) => renderFolderNode(node, 0))
            .join('');

        treeEl.innerHTML = `
            <div class="tree-root-actions">
                <button type="button" class="tree-add-root ${addRootClass}" id="tree-add-root-page">+ Añade una página más</button>
            </div>
            <div class="tree-root">
                ${rootPages}
                ${folderNodes}
            </div>
        `;

        document.getElementById('tree-add-root-page').onclick = () => {
            selectedPath = '';
            resetForm();
            renderTree();
        };

        bindTreeEvents();
    }

    function renderContextHelp() {
        const pageCount = items.length;
        const folderCount = new Set(items.map((item) => item.carpeta).filter(Boolean)).size;
        listEl.innerHTML = `
            <div class="solutions-context-card">
                <strong>Estructura</strong>
                <p>${pageCount} página(s) distribuida(s) en ${folderCount} carpeta(s).</p>
                <p>Selecciona una página del árbol o usa los botones <code>+</code> para crear una nueva dentro de la ruta que necesites.</p>
            </div>
        `;
    }

    async function loadAll() {
        let response = await fetch(api('/solutions'));
        let data = await response.json();
        if (!response.ok) {
            throw new Error(getErrorMessage(data.detail, 'No se pudieron cargar las soluciones.'));
        }

        items = data.items || [];
        await ensureHomePage();

        response = await fetch(api('/solutions'));
        data = await response.json();
        if (!response.ok) {
            throw new Error(getErrorMessage(data.detail, 'No se pudieron cargar las soluciones.'));
        }

        items = data.items || [];
        renderTree();
        renderContextHelp();
    }

    async function openPage(id) {
        const response = await fetch(api(`/solutions/${id}`));
        const data = await response.json();
        if (!response.ok) {
            throw new Error(getErrorMessage(data.detail, 'No se pudo abrir la página.'));
        }
        selectedId = data._id;
        selectedPath = data.carpeta || '';
        folderEl.value = data.carpeta || '';
        titleEl.value = data.titulo || '';
        descriptionQuill.root.innerHTML = data.descripcion_html || '';
        formTitleEl.innerText = data.titulo || 'Editar página';
        formSubtitleEl.innerText = data.carpeta ? `Dentro de ${data.carpeta}` : 'Página principal';
        showMeta(data.created_at, data.updated_at);
        deleteButton.classList.remove('hidden');
        resetButton.classList.remove('hidden');
        renderTree();
    }

    async function savePage(event) {
        event.preventDefault();
        const payload = {
            carpeta: folderEl.value,
            titulo: titleEl.value,
            descripcion_html: descriptionQuill.root.innerHTML
        };
        const response = await fetch(selectedId ? api(`/solutions/${selectedId}`) : api('/solutions'), {
            method: selectedId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(getErrorMessage(data.detail, 'No se pudo guardar la página.'));
        }
        selectedId = data._id;
        selectedPath = data.carpeta || '';
        showToast(selectedId ? 'Página guardada.' : 'Página creada.', 'success');
        await loadAll();
        await openPage(data._id);
    }

    async function removePage() {
        if (!selectedId) return;
        const confirmed = await showConfirmToast('¿Deseas eliminar esta página?', {
            type: 'error',
            confirmLabel: 'Eliminar',
            cancelLabel: 'Cancelar'
        });
        if (!confirmed) return;

        const response = await fetch(api(`/solutions/${selectedId}`), { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(getErrorMessage(data.detail, 'No se pudo eliminar la página.'));
        }
        showToast(data.msg || 'Página eliminada.', 'success');
        selectedId = null;
        await loadAll();
        resetForm();
    }

    async function openSolutionsView(event) {
        if (event) event.preventDefault();
        document.getElementById('view-table').classList.add('hidden');
        document.getElementById('view-form').classList.add('hidden');
        document.getElementById('view-dashboard').classList.add('hidden');
        document.getElementById('view-mantenimiento').classList.add('hidden');
        view.classList.remove('hidden');
        updateActiveNavLink('nav-soluciones-link');
        try {
            await loadAll();
            if (!selectedId) {
                resetForm();
            }
        } catch (error) {
            console.error(error);
            showToast(error.message || 'No se pudieron cargar las soluciones.', 'error');
        }
    }

    navSolutions.onclick = openSolutionsView;
    searchEl.oninput = () => {
        renderTree();
        renderContextHelp();
    };
    newButton.onclick = () => {
        selectedPath = '';
        resetForm();
        renderTree();
    };
    resetButton.onclick = () => {
        selectedId = null;
        resetForm();
        renderTree();
    };
    cancelButton.onclick = () => {
        selectedId = null;
        resetForm();
        renderTree();
    };
    deleteButton.onclick = async () => {
        try {
            await removePage();
        } catch (error) {
            console.error(error);
            showToast(error.message || 'No se pudo eliminar la página.', 'error');
        }
    };
    formEl.onsubmit = async (event) => {
        try {
            await savePage(event);
        } catch (error) {
            console.error(error);
            showToast(error.message || 'No se pudo guardar la página.', 'error');
        }
    };
})();
