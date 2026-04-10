const API_BASE_URL = window.SERVICEDESK_CONFIG?.apiBaseUrl || 'http://localhost:8001';
const DEFAULT_USER = 'Usuario Soporte';
const CHART_COLORS = ['#0067ff', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];
const STATUS_OPTIONS = ['Abierto', 'Asignado', 'En espera', 'En progreso', 'Resuelto', 'Cerrado'];

let allTickets = [];
let currentFilter = 'pendientes';
let editingTicketId = null;
let isResolutionSave = false;
let formDirty = false;
let charts = {};
let dashboardData = null;
let selectedFiles = [];
let currentTicket = null;

const quillOptions = {
    modules: {
        toolbar: [
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ color: [] }, { background: [] }],
            [{ list: 'ordered' }, { list: 'bullet' }],
            [{ align: [] }],
            ['blockquote', 'link'],
            ['clean']
        ]
    },
    theme: 'snow'
};

const quill = new Quill('#editor-container', quillOptions);
const resolutionQuill = new Quill('#resolution-editor', quillOptions);
const commentQuill = new Quill('#comment-editor', {
    modules: { toolbar: [['bold', 'italic', 'underline'], [{ list: 'bullet' }], ['link'], ['clean']] },
    theme: 'snow'
});

const elements = {
    chatters: {
        body: document.getElementById('tickets-body'),
        countLabel: document.getElementById('ticket-count'),
        emptyState: document.getElementById('empty-state-container'),
        table: document.querySelector('.zoho-table')
    },
    attachmentList: document.getElementById('attachment-list'),
    fileNameDisplay: document.getElementById('file-name-display'),
    fileInput: document.getElementById('f-adjunto'),
    dropZone: document.getElementById('drop-zone'),
    commentButton: document.getElementById('add-comment-btn'),
    history: document.getElementById('ticket-history'),
    comments: document.getElementById('comments-list'),
    tabsContainer: document.getElementById('tabs-container'),
    ticketIdField: document.querySelector('.ticket-id-field-container'),
    formTitle: document.getElementById('form-title'),
    searchInput: document.getElementById('nav-search-input'),
    dashboardMetric: document.getElementById('dashboard-metric'),
    toastContainer: document.getElementById('toast-container')
};

function apiUrl(path) {
    return `${API_BASE_URL}${path}`;
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

function formatDate(value, withTime = false) {
    if (!value) return '--';
    const date = new Date(value);
    const options = withTime
        ? { dateStyle: 'medium', timeStyle: 'short' }
        : { dateStyle: 'medium' };
    return new Intl.DateTimeFormat('es-PE', options).format(date);
}

function bytesToSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let index = 0;
    let size = bytes;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function apiAssetUrl(path) {
    return `${API_BASE_URL}${path}`;
}

function showToast(message, type = 'info', options = {}) {
    const { duration = 4500 } = options;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div class="toast-message">${escapeHtml(message)}</div>
        <button type="button" class="toast-close" aria-label="Cerrar notificación">&times;</button>
    `;

    const removeToast = () => {
        toast.classList.add('removing');
        window.setTimeout(() => toast.remove(), 180);
    };

    toast.querySelector('.toast-close').onclick = removeToast;
    elements.toastContainer.appendChild(toast);

    if (duration > 0) {
        window.setTimeout(removeToast, duration);
    }
}

function showConfirmToast(message, options = {}) {
    const {
        type = 'info',
        confirmLabel = 'Aceptar',
        cancelLabel = 'Cancelar'
    } = options;

    return new Promise((resolve) => {
        const toast = document.createElement('div');
        toast.className = `toast ${type} toast-confirm`;
        toast.innerHTML = `
            <div class="toast-message">${escapeHtml(message)}</div>
            <button type="button" class="toast-close" aria-label="Cerrar notificación">&times;</button>
            <div class="toast-actions">
                <button type="button" class="toast-action-btn toast-action-secondary">${escapeHtml(cancelLabel)}</button>
                <button type="button" class="toast-action-btn toast-action-primary">${escapeHtml(confirmLabel)}</button>
            </div>
        `;

        let resolved = false;
        const finish = (value) => {
            if (resolved) return;
            resolved = true;
            toast.classList.add('removing');
            window.setTimeout(() => toast.remove(), 180);
            resolve(value);
        };

        toast.querySelector('.toast-close').onclick = () => finish(false);
        toast.querySelector('.toast-action-secondary').onclick = () => finish(false);
        toast.querySelector('.toast-action-primary').onclick = () => finish(true);
        elements.toastContainer.appendChild(toast);
    });
}

function updateActiveNavLink(id) {
    document.querySelectorAll('.nav-links a').forEach((a) => a.classList.remove('active'));
    const link = document.getElementById(id);
    if (link) link.classList.add('active');
}

function markFormDirty() {
    formDirty = true;
}

function resetEditors() {
    quill.setContents([]);
    resolutionQuill.setContents([]);
    commentQuill.setContents([]);
}

function resetAttachmentSelection() {
    selectedFiles = [];
    elements.fileInput.value = '';
    renderAttachmentList();
}

function resetFormState() {
    editingTicketId = null;
    currentTicket = null;
    isResolutionSave = false;
    formDirty = false;
    document.getElementById('pro-ticket-form').reset();
    resetEditors();
    resetAttachmentSelection();
    elements.ticketIdField.classList.add('hidden');
    elements.tabsContainer.classList.add('hidden');
    elements.history.innerHTML = '<div class="muted-panel">El historial aparecerá cuando el ticket exista.</div>';
    elements.comments.innerHTML = '<div class="muted-panel">Los comentarios aparecerán cuando el ticket exista.</div>';
    elements.formTitle.innerText = 'Nueva Solicitud';
    document.querySelector('.btn-save').innerText = 'Agregar solicitud';
    populateStatusOptions(STATUS_OPTIONS, 'Abierto');
    syncTicketFormState();
    showTab('details-section');
}

function setTrackingAvailability(enabled) {
    document.querySelector('[data-tab="tracking-section"]').disabled = !enabled;
    document.querySelector('[data-tab="tracking-section"]').classList.toggle('tab-disabled', !enabled);
    elements.commentButton.disabled = !enabled;
}

function populateStatusOptions(options, selectedValue = '') {
    const statusSelect = document.getElementById('f-estado');
    statusSelect.innerHTML = options.map((option) => {
        if (typeof option === 'string') {
            return `<option value="${option}">${option}</option>`;
        }
        const value = option.value || '';
        const label = option.label || value;
        const disabled = option.disabled ? ' disabled' : '';
        return `<option value="${value}"${disabled}>${label}</option>`;
    }).join('');
    const selectedOption = options.find((option) => (typeof option === 'string' ? option : option.value) === selectedValue);
    const fallbackOption = options.find((option) => !(typeof option === 'object' && option.disabled));
    const fallbackValue = typeof fallbackOption === 'string' ? fallbackOption : fallbackOption?.value || '';
    statusSelect.value = selectedOption ? selectedValue : fallbackValue;
}

function setFormReadonlyState(isClosed) {
    const editableFieldIds = [
        'f-solicitante',
        'f-tipo',
        'f-prioridad',
        'f-modo',
        'f-sucursal',
        'f-categoria',
        'f-subcategoria',
        'f-articulo',
        'f-asunto'
    ];

    editableFieldIds.forEach((fieldId) => {
        document.getElementById(fieldId).disabled = isClosed;
    });

    quill.enable(!isClosed);
    resolutionQuill.enable(!isClosed);
    commentQuill.enable(!isClosed);
    elements.fileInput.disabled = isClosed;
    elements.dropZone.classList.toggle('disabled', isClosed);
    elements.dropZone.setAttribute('aria-disabled', String(isClosed));
    elements.commentButton.disabled = !editingTicketId || isClosed;
}

function syncTicketFormState() {
    const statusSelect = document.getElementById('f-estado');
    const isClosed = currentTicket?.estado === 'Cerrado';
    const selectedStatus = currentTicket?.estado || statusSelect.value || 'Abierto';

    if (!editingTicketId) {
        populateStatusOptions(STATUS_OPTIONS, selectedStatus);
        statusSelect.disabled = false;
        setFormReadonlyState(false);
        return;
    }

    if (isClosed) {
        populateStatusOptions(['Cerrado', 'Resuelto'], selectedStatus);
        statusSelect.disabled = false;
        setFormReadonlyState(true);
        return;
    }

    populateStatusOptions(STATUS_OPTIONS, selectedStatus);
    setFormReadonlyState(false);
    if (isResolutionSave) {
        statusSelect.value = 'Resuelto';
        statusSelect.disabled = true;
    } else {
        statusSelect.disabled = false;
    }
}

const toggleView = (showForm) => {
    document.getElementById('view-mantenimiento').classList.add('hidden');
    document.getElementById('view-dashboard').classList.add('hidden');

    if (showForm) {
        document.getElementById('view-table').classList.add('hidden');
        document.getElementById('view-form').classList.remove('hidden');
        if (!editingTicketId) {
            resetFormState();
            setRandomUser();
            setTrackingAvailability(false);
        }
    } else {
        editingTicketId = null;
        currentTicket = null;
        formDirty = false;
        document.getElementById('view-form').classList.add('hidden');
        document.getElementById('view-table').classList.remove('hidden');
        updateActiveNavLink('nav-solicitudes-link');
        cargarTickets();
    }
};

function showInicio() {
    document.getElementById('view-table').classList.add('hidden');
    document.getElementById('view-form').classList.add('hidden');
    document.getElementById('view-dashboard').classList.add('hidden');
    document.getElementById('view-mantenimiento').classList.remove('hidden');
    updateActiveNavLink('nav-inicio-link');
    refreshHomeSummary();
}

async function showDashboard() {
    document.getElementById('view-table').classList.add('hidden');
    document.getElementById('view-form').classList.add('hidden');
    document.getElementById('view-mantenimiento').classList.add('hidden');
    document.getElementById('view-dashboard').classList.remove('hidden');
    updateActiveNavLink('nav-dashboard-link');
    await cargarMetricas();
    initCharts();
}

async function cargarCategorias() {
    try {
        const res = await fetch('categorias.json');
        if (!res.ok) throw new Error('No se pudieron cargar las categorías.');
        const categoriasData = await res.json();
        window.__categoriasData = categoriasData;

        const catSelect = document.getElementById('f-categoria');
        const filterCat = document.getElementById('filter-category');
        catSelect.innerHTML = '<option value="">Seleccione...</option>';
        filterCat.innerHTML = '<option value="">Todas las categorías</option>';

        Object.keys(categoriasData).forEach((cat) => {
            if (cat === 'Categoria') return;
            const option = `<option value="${cat}">${cat}</option>`;
            catSelect.innerHTML += option;
            filterCat.innerHTML += option;
        });
    } catch (error) {
        console.error(error);
        showToast('No se pudieron cargar las categorías.', 'error');
    }
}

function syncCategoryCascade(ticket = null) {
    const categoriasData = window.__categoriasData || {};
    const catSelect = document.getElementById('f-categoria');
    const subSelect = document.getElementById('f-subcategoria');
    const artSelect = document.getElementById('f-articulo');
    const cat = catSelect.value;

    subSelect.innerHTML = '<option value="">Seleccione...</option>';
    artSelect.innerHTML = '<option value="">Seleccione subcategoría...</option>';
    subSelect.disabled = !cat;
    artSelect.disabled = true;

    if (cat && categoriasData[cat]) {
        Object.keys(categoriasData[cat]).forEach((sub) => {
            subSelect.innerHTML += `<option value="${sub}">${sub}</option>`;
        });
    }

    if (ticket?.subcategoria) {
        subSelect.value = ticket.subcategoria;
        const sub = subSelect.value;
        artSelect.innerHTML = '<option value="">Seleccione...</option>';
        artSelect.disabled = !sub;
        (categoriasData[cat]?.[sub] || []).forEach((art) => {
            artSelect.innerHTML += `<option value="${art}">${art}</option>`;
        });
        artSelect.value = ticket.articulo || '';
    }
}

function renderAttachmentList() {
    const existing = currentTicket?.adjuntos || [];
    const pending = selectedFiles.map((file, index) => ({
        pending: true,
        id: `pending-${index}`,
        original_name: file.name,
        size: file.size
    }));

    const items = [...existing, ...pending];
    if (!items.length) {
        elements.attachmentList.innerHTML = '<div class="muted-panel">Sin adjuntos.</div>';
        elements.fileNameDisplay.innerText = '';
        return;
    }

    elements.fileNameDisplay.innerText = selectedFiles.length ? `${selectedFiles.length} archivo(s) listos para subir` : '';
    elements.attachmentList.innerHTML = items.map((item, index) => {
        const action = item.pending
            ? `<button type="button" class="attachment-remove" onclick="removePendingFile(${index - existing.length})">Quitar</button>`
            : `<a href="${apiAssetUrl(item.url)}" target="_blank" rel="noopener">Abrir</a>`;
        return `
            <div class="attachment-item ${item.pending ? 'pending' : ''}">
                <div>
                    <strong>${escapeHtml(item.original_name)}</strong>
                    <span>${bytesToSize(item.size)}</span>
                </div>
                ${action}
            </div>`;
    }).join('');
}

function removePendingFile(index) {
    selectedFiles.splice(index, 1);
    renderAttachmentList();
    markFormDirty();
}
window.removePendingFile = removePendingFile;

function renderHistory(ticket) {
    const history = ticket?.historial || [];
    if (!history.length) {
        elements.history.innerHTML = '<div class="muted-panel">Todavía no hay eventos registrados.</div>';
        return;
    }

    elements.history.innerHTML = history.slice().reverse().map((entry) => `
        <article class="history-item">
            <div class="history-badge"><i class="fa-solid fa-clock-rotate-left"></i></div>
            <div class="history-content">
                <strong>${escapeHtml(entry.message || entry.event_type)}</strong>
                <p>${escapeHtml(entry.actor || 'Sistema')} &middot; ${formatDate(entry.created_at, true)}</p>
            </div>
        </article>
    `).join('');
}

function renderComments(ticket) {
    const comments = ticket?.comentarios || [];
    const canDeleteComments = ticket?.estado !== 'Cerrado';
    if (!comments.length) {
        elements.comments.innerHTML = '<div class="muted-panel">Todavía no hay comentarios.</div>';
        return;
    }

    elements.comments.innerHTML = comments.slice().reverse().map((comment) => `
        <article class="comment-item">
            <header>
                <div class="comment-meta">
                    <strong>${escapeHtml(comment.autor)}</strong>
                    <span>${formatDate(comment.created_at, true)}</span>
                </div>
                ${canDeleteComments ? `
                    <button
                        type="button"
                        class="comment-delete-btn"
                        onclick="eliminarComentario('${comment.id}')"
                        aria-label="Eliminar comentario"
                        title="Eliminar comentario"
                    >
                        Eliminar
                    </button>
                ` : ''}
            </header>
            <div class="comment-body">${comment.comentario_html}</div>
        </article>
    `).join('');
}

function buildFormData() {
    const formData = new FormData();
    let estadoValue = document.getElementById('f-estado').value;
    const resolutionHtml = resolutionQuill.root.innerHTML;
    const resolutionChanged = resolutionHtml !== (currentTicket?.resolucion_html || '');
    if (isResolutionSave && currentTicket?.estado !== 'Cerrado' && stripHtml(resolutionHtml) && resolutionChanged) {
        estadoValue = 'Resuelto';
    }
    const payload = {
        solicitante: document.getElementById('f-solicitante').value,
        tipo_solicitud: document.getElementById('f-tipo').value,
        prioridad: document.getElementById('f-prioridad').value,
        estado: estadoValue,
        modo: document.getElementById('f-modo').value,
        sucursal: document.getElementById('f-sucursal').value,
        categoria: document.getElementById('f-categoria').value,
        subcategoria: document.getElementById('f-subcategoria').value,
        articulo: document.getElementById('f-articulo').value,
        asunto: document.getElementById('f-asunto').value,
        descripcion_html: quill.root.innerHTML,
        resolucion_html: resolutionHtml
    };

    Object.entries(payload).forEach(([key, value]) => formData.append(key, value || ''));
    selectedFiles.forEach((file) => formData.append('files', file));
    return formData;
}

function applyTicketsToView() {
    showInicio();
    if (!document.getElementById('view-table').classList.contains('hidden')) {
        aplicarFiltros();
    }
}

function refreshHomeSummary() {
    document.getElementById('count-total').innerText = allTickets.length;
    document.getElementById('count-pending').innerText = allTickets.filter((t) => !['Resuelto', 'Cerrado'].includes(t.estado)).length;
    document.getElementById('count-resolved').innerText = allTickets.filter((t) => ['Resuelto', 'Cerrado'].includes(t.estado)).length;
}

async function cargarTickets() {
    try {
        const res = await fetch(apiUrl('/tickets'));
        if (!res.ok) throw new Error('No se pudieron cargar los tickets.');
        allTickets = await res.json();
        aplicarFiltros();
        if (!document.getElementById('view-dashboard').classList.contains('hidden')) {
            await cargarMetricas();
            initCharts();
        }
        refreshHomeSummary();
    } catch (error) {
        console.error(error);
        showToast('Error al cargar tickets desde la API.', 'error');
    }
}

async function cargarMetricas() {
    try {
        const res = await fetch(apiUrl('/tickets/metrics'));
        if (!res.ok) throw new Error('No se pudieron cargar las métricas del panel.');
        dashboardData = await res.json();
    } catch (error) {
        console.error(error);
        dashboardData = null;
    }
}

function aplicarFiltros() {
    const term = elements.searchInput.value.toLowerCase();
    const prioFilter = document.getElementById('filter-priority').value;
    const catFilter = document.getElementById('filter-category').value;

    const filtrados = allTickets.filter((ticket) => {
        const matchSearch = [ticket.asunto, ticket.solicitante, ticket.categoria, ticket['ID-ITIL']]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(term));
        const estado = (ticket.estado || 'Abierto').toLowerCase();
        const matchPrio = prioFilter ? ticket.prioridad === prioFilter : true;
        const matchCat = catFilter ? ticket.categoria === catFilter : true;
        let matchView = false;
        if (currentFilter === 'todas') matchView = true;
        if (currentFilter === 'pendientes') matchView = ['abierto', 'asignado', 'en espera', 'en progreso'].includes(estado);
        if (currentFilter === 'cerradas') matchView = ['resuelto', 'cerrado'].includes(estado);
        return matchSearch && matchPrio && matchCat && matchView;
    });

    renderTable(filtrados);
}

function renderTable(data) {
    const { body, countLabel, emptyState, table } = elements.chatters;
    body.innerHTML = '';
    countLabel.innerText = `${data.length} Resultados`;

    if (!data.length) {
        emptyState.classList.remove('hidden');
        table.classList.add('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    table.classList.remove('hidden');

    data.forEach((ticket) => {
        const ticketDisplayId = ticket['ID-ITIL'] || `#${String(ticket._id).slice(-5)}`;
        const fecha = formatDate(ticket.fecha_creacion);
        const prioClass = ticket.prioridad === 'Alta' ? 'prio-alta' : ticket.prioridad === 'Normal' ? 'prio-normal' : 'prio-baja';
        body.innerHTML += `
            <tr class="animate-in clickable-row" onclick="prepararEdicion('${ticket._id}')">
                <td>${ticketDisplayId}</td>
                <td style="color:var(--zoho-blue); font-weight:600;">${escapeHtml(ticket.asunto)}</td>
                <td>${escapeHtml(ticket.solicitante || '--')}</td>
                <td><span class="status-pill">${escapeHtml(ticket.estado || 'Abierto')}</span></td>
                <td><span class="prio-tag ${prioClass}">${escapeHtml(ticket.prioridad)}</span></td>
                <td>${fecha}</td>
                <td class="actions-cell" onclick="event.stopPropagation()">
                    <i class="fa-solid fa-pen-to-square edit-btn" onclick="prepararEdicion('${ticket._id}')" title="Ver Detalles/Editar"></i>
                    <i class="fa-solid fa-trash delete-btn" onclick="eliminarTicket('${ticket._id}')" title="Eliminar"></i>
                </td>
            </tr>`;
    });
}

async function loadTicket(id) {
    const res = await fetch(apiUrl(`/tickets/${id}`));
        if (!res.ok) throw new Error('No se pudo abrir el ticket.');
    return res.json();
}

async function prepararEdicion(id) {
    try {
        const ticket = await loadTicket(id);
        resetAttachmentSelection();
        currentTicket = ticket;
        editingTicketId = id;
        formDirty = false;
        setTrackingAvailability(true);
        elements.tabsContainer.classList.remove('hidden');
        elements.ticketIdField.classList.remove('hidden');
        elements.formTitle.innerText = `Editar: ${ticket['ID-ITIL'] || `#${id.slice(-5)}`}`;

        document.getElementById('f-codigo').value = ticket['ID-ITIL'] || '';
        document.getElementById('f-solicitante').value = ticket.solicitante || DEFAULT_USER;
        document.getElementById('f-tipo').value = ticket.tipo_solicitud || 'Incidente';
        document.getElementById('f-prioridad').value = ticket.prioridad || 'Baja';
        document.getElementById('f-modo').value = ticket.modo || '';
        document.getElementById('f-sucursal').value = ticket.sucursal || '';
        document.getElementById('f-asunto').value = ticket.asunto || '';
        document.getElementById('f-categoria').value = ticket.categoria || '';
        quill.root.innerHTML = ticket.descripcion_html || '';
        resolutionQuill.root.innerHTML = ticket.resolucion_html || '';
        commentQuill.setContents([]);
        syncCategoryCascade(ticket);
        renderAttachmentList();
        renderHistory(ticket);
        renderComments(ticket);
        syncTicketFormState();
        showTab('details-section');

        document.getElementById('view-table').classList.add('hidden');
        document.getElementById('view-form').classList.remove('hidden');
    } catch (error) {
        console.error(error);
        showToast('No se pudo abrir el ticket.', 'error');
    }
}
window.prepararEdicion = prepararEdicion;

async function eliminarTicket(id) {
    const confirmed = await showConfirmToast('\u00BFDeseas eliminar este ticket?', {
        type: 'error',
        confirmLabel: 'Eliminar',
        cancelLabel: 'Cancelar'
    });
    if (!confirmed) return;
    try {
        const res = await fetch(apiUrl(`/tickets/${id}`), { method: 'DELETE' });
        if (!res.ok) throw new Error('No se pudo eliminar el ticket.');
        await cargarTickets();
        showToast('Ticket eliminado.', 'success');
    } catch (error) {
        console.error(error);
        showToast('No se pudo eliminar el ticket.', 'error');
    }
}
window.eliminarTicket = eliminarTicket;

function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach((content) => content.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
    document.getElementById(tabId).classList.remove('hidden');
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');

    const saveBtn = document.querySelector('.btn-save');
    if (currentTicket?.estado === 'Cerrado') {
        saveBtn.innerText = 'Volver a Resuelto';
        isResolutionSave = false;
    } else if (tabId === 'resolution-section') {
        saveBtn.innerText = 'Guardar resolución';
        isResolutionSave = true;
    } else {
        saveBtn.innerText = editingTicketId ? 'Actualizar Solicitud' : 'Agregar solicitud';
        isResolutionSave = false;
    }
    syncTicketFormState();
}

function setRandomUser() {
    const photoImg = document.getElementById('user-photo');
    const solicitanteInput = document.getElementById('f-solicitante');
    solicitanteInput.value = DEFAULT_USER;
    photoImg.src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(DEFAULT_USER)}`;
}

function makeLineChart(canvasId, dataPoints, label, color, textColor, gridColor) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    if (charts[canvasId]) charts[canvasId].destroy();

    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, color + '44');
    gradient.addColorStop(1, color + '00');

    charts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dataPoints.map((item) => item.label),
            datasets: [{
                label,
                data: dataPoints.map((item) => item.count),
                borderColor: color,
                backgroundColor: gradient,
                fill: true,
                tension: 0.35,
                pointRadius: 3,
                pointHoverRadius: 6,
                borderWidth: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false }, ticks: { color: textColor } },
                y: { grid: { color: gridColor }, ticks: { color: textColor, precision: 0 } }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function initCharts() {
    if (!dashboardData) return;
    const isDark = document.body.classList.contains('dark-mode');
    const textColor = isDark ? '#94a3b8' : '#666';
    const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
    Chart.defaults.color = textColor;

    const metric = elements.dashboardMetric.value;
    const metricMap = dashboardData.by_metric?.[metric] || {};
    const labels = Object.keys(metricMap);
    const values = Object.values(metricMap);
    const metricCanvas = document.getElementById('chart-metrics').getContext('2d');
    if (charts.metric) charts.metric.destroy();
    charts.metric = new Chart(metricCanvas, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data: values, backgroundColor: labels.map((_, idx) => CHART_COLORS[idx % CHART_COLORS.length]), borderWidth: 0, hoverOffset: 15 }]
        },
        options: { cutout: '70%', plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, padding: 20 } } } }
    });

    const dailyCtx = document.getElementById('chart-daily-status').getContext('2d');
    if (charts.daily) charts.daily.destroy();
    charts.daily = new Chart(dailyCtx, {
        type: 'bar',
        data: {
            labels: dashboardData.status_last_7.map((item) => item.label),
            datasets: [
                { label: 'Cerrados', data: dashboardData.status_last_7.map((item) => item.cerrados), backgroundColor: '#10b981', borderRadius: 6 },
                { label: 'Resueltos', data: dashboardData.status_last_7.map((item) => item.resueltos), backgroundColor: '#0067ff', borderRadius: 6 }
            ]
        },
        options: {
            responsive: true,
            scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: { color: gridColor }, ticks: { precision: 0 } } },
            plugins: { legend: { position: 'bottom', labels: { usePointStyle: true } } }
        }
    });

    makeLineChart('chart-history-received', dashboardData.received_last_30, 'Recibidos', '#0067ff', textColor, gridColor);
    makeLineChart('chart-history-resolved', dashboardData.resolved_last_30, 'Resueltos/Cerrados', '#10b981', textColor, gridColor);
}

async function submitTicketForm(event) {
    event.preventDefault();
    if (currentTicket?.estado === 'Cerrado' && document.getElementById('f-estado').value !== 'Resuelto') {
        showToast('Selecciona Resuelto si deseas reabrir este ticket.', 'info');
        return;
    }
    const formData = buildFormData();
    const successMessage = editingTicketId ? 'Ticket actualizado' : 'Ticket creado';
    try {
        const url = editingTicketId ? apiUrl(`/tickets/${editingTicketId}`) : apiUrl('/tickets');
        const res = await fetch(url, { method: editingTicketId ? 'PUT' : 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'No se pudo guardar el ticket.');
        currentTicket = data;
        selectedFiles = [];
        showToast(successMessage, 'success');
        await cargarTickets();
        toggleView(false);
    } catch (error) {
        console.error(error);
        showToast(error.message || 'No se pudo guardar el ticket.', 'error');
    }
}

async function agregarComentario() {
    if (!editingTicketId) return;
    if (currentTicket?.estado === 'Cerrado') {
        showToast('El ticket esta cerrado. Cambialo a Resuelto antes de agregar comentarios.', 'error');
        return;
    }
    const comentarioHtml = commentQuill.root.innerHTML;
    if (!stripHtml(comentarioHtml)) {
        showToast('Escribe un comentario antes de guardar.', 'error');
        return;
    }

    try {
        const res = await fetch(apiUrl(`/tickets/${editingTicketId}/comments`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autor: document.getElementById('f-solicitante').value || DEFAULT_USER, comentario_html: comentarioHtml })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'No se pudo guardar el comentario.');
        currentTicket = data;
        commentQuill.setContents([]);
        renderHistory(data);
        renderComments(data);
        await cargarTickets();
    } catch (error) {
        console.error(error);
        showToast(error.message || 'No se pudo guardar el comentario.', 'error');
    }
}

async function eliminarComentario(commentId) {
    if (!editingTicketId) return;
    const confirmed = await showConfirmToast('\u00BFDeseas eliminar este comentario?', {
        type: 'error',
        confirmLabel: 'Eliminar',
        cancelLabel: 'Cancelar'
    });
    if (!confirmed) return;

    try {
        const res = await fetch(apiUrl(`/tickets/${editingTicketId}/comments/${commentId}`), {
            method: 'DELETE'
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'No se pudo eliminar el comentario.');
        currentTicket = data;
        renderHistory(data);
        renderComments(data);
        await cargarTickets();
        showToast('Comentario eliminado.', 'success');
    } catch (error) {
        console.error(error);
        showToast(error.message || 'No se pudo eliminar el comentario.', 'error');
    }
}
window.eliminarComentario = eliminarComentario;

function bindEvents() {
    document.getElementById('nav-inicio-link').onclick = (event) => {
        event.preventDefault();
        showInicio();
    };
    document.getElementById('nav-dashboard-link').onclick = async (event) => {
        event.preventDefault();
        await showDashboard();
    };
    document.getElementById('nav-solicitudes-link').onclick = (event) => {
        event.preventDefault();
        toggleView(false);
    };
    document.getElementById('show-form-btn').onclick = () => toggleView(true);
    document.getElementById('nav-add-ticket').onclick = () => toggleView(true);
    document.getElementById('cancel-form-btn').onclick = () => toggleView(false);
    document.getElementById('close-form-btn').onclick = () => toggleView(false);
    document.getElementById('reset-form-btn').onclick = () => {
        if (editingTicketId && currentTicket) {
            prepararEdicion(editingTicketId);
        } else {
            resetFormState();
            setRandomUser();
        }
    };
    document.getElementById('pro-ticket-form').onsubmit = submitTicketForm;
    document.querySelectorAll('.tab-btn').forEach((btn) => { btn.onclick = () => showTab(btn.dataset.tab); });
    document.getElementById('add-comment-btn').onclick = agregarComentario;
    elements.searchInput.oninput = aplicarFiltros;
    document.getElementById('filter-priority').onchange = aplicarFiltros;
    document.getElementById('filter-category').onchange = aplicarFiltros;
    elements.dashboardMetric.onchange = initCharts;
    document.getElementById('current-view-trigger').onclick = (e) => {
        e.stopPropagation();
        document.getElementById('view-menu').classList.toggle('hidden');
    };
    document.querySelectorAll('#view-menu li').forEach((li) => {
        li.onclick = function onSelectView() {
            currentFilter = this.dataset.view;
            document.getElementById('view-title').innerText = this.innerText;
            document.getElementById('view-menu').classList.add('hidden');
            aplicarFiltros();
        };
    });
    window.onclick = () => document.getElementById('view-menu').classList.add('hidden');

    document.getElementById('f-categoria').onchange = () => {
        syncCategoryCascade();
        markFormDirty();
    };
    document.getElementById('f-subcategoria').onchange = () => {
        const categoriasData = window.__categoriasData || {};
        const cat = document.getElementById('f-categoria').value;
        const sub = document.getElementById('f-subcategoria').value;
        const artSelect = document.getElementById('f-articulo');
        artSelect.innerHTML = '<option value="">Seleccione...</option>';
        artSelect.disabled = !sub;
        (categoriasData[cat]?.[sub] || []).forEach((art) => {
            artSelect.innerHTML += `<option value="${art}">${art}</option>`;
        });
        markFormDirty();
    };
    document.getElementById('f-articulo').onchange = markFormDirty;
    document.querySelectorAll('#pro-ticket-form input, #pro-ticket-form select').forEach((input) => {
        input.addEventListener('change', markFormDirty);
    });
    quill.on('text-change', markFormDirty);
    resolutionQuill.on('text-change', markFormDirty);
    commentQuill.on('text-change', markFormDirty);

    elements.dropZone.onclick = () => {
        if (elements.fileInput.disabled) return;
        elements.fileInput.click();
    };
    elements.dropZone.ondragover = (e) => {
        if (elements.fileInput.disabled) return;
        e.preventDefault();
        elements.dropZone.classList.add('dragover');
    };
    elements.dropZone.ondragleave = () => elements.dropZone.classList.remove('dragover');
    elements.dropZone.ondrop = (e) => {
        if (elements.fileInput.disabled) return;
        e.preventDefault();
        elements.dropZone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) {
            selectedFiles = [...selectedFiles, ...files];
            renderAttachmentList();
            markFormDirty();
        }
    };
    elements.fileInput.onchange = () => {
        if (elements.fileInput.disabled) return;
        const files = Array.from(elements.fileInput.files || []);
        if (files.length) {
            selectedFiles = [...selectedFiles, ...files];
            renderAttachmentList();
            markFormDirty();
        }
    };

    const themeToggle = document.getElementById('theme-toggle');
    themeToggle.onclick = () => {
        document.body.classList.toggle('dark-mode');
        const isDark = document.body.classList.contains('dark-mode');
        themeToggle.classList.replace(isDark ? 'fa-moon' : 'fa-sun', isDark ? 'fa-sun' : 'fa-moon');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
        if (!document.getElementById('view-dashboard').classList.contains('hidden')) initCharts();
    };
    if (localStorage.getItem('theme') === 'dark') {
        document.body.classList.add('dark-mode');
        themeToggle.classList.replace('fa-moon', 'fa-sun');
    }
}

async function initApp() {
    bindEvents();
    await cargarCategorias();
    resetFormState();
    setRandomUser();
    await cargarTickets();
    showInicio();
}

initApp();
