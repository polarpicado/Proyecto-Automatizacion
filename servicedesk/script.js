let allTickets = [];
let currentFilter = 'pendientes';
let editingTicketId = null; // Rastrea si estamos editando
let isResolutionSave = false;
let formDirty = false; // Rastrea cambios en el formulario
let charts = {}; // Para guardar instancias de Chart.js

// --- CONFIGURACIÓN QUILL (100 colores y herramientas) ---
const quill = new Quill('#editor-container', {
    modules: {
        toolbar: [
            [{ 'font': [] }],
            [{ 'size': ['8', '9', '10', '11', '12', '13', '14', '15', '16', '18', '24', '36'] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ 'color': [] }, { 'background': [] }],
            [{ 'script': 'sub'}, { 'script': 'super' }],
            [{ 'header': 1 }, { 'header': 2 }, 'blockquote'],
            [{ 'list': 'ordered'}, { 'list': 'bullet' }],
            [{ 'indent': '-1'}, { 'indent': '+1' }],
            [{ 'align': [] }],
            ['link', 'image', 'video', 'formula'],
            ['clean']
        ]
    },
    theme: 'snow'
});

// --- DATOS DE CASCADA (Desde JSON) ---
let categoriasData = {};

async function cargarCategorias() {
    try {
        const res = await fetch('categorias.json');
        if (!res.ok) throw new Error("No se pudo encontrar categorias.json");
        categoriasData = await res.json();
        
        const catSelect = document.getElementById('f-categoria');
        const filterCat = document.getElementById('filter-category');
        
        catSelect.innerHTML = '<option value="">Seleccione...</option>';
        filterCat.innerHTML = '<option value="">Todas las categorías</option>';

        // Poblar categorías únicas (saltando la entrada de ejemplo "Categoria")
        Object.keys(categoriasData).forEach(cat => {
            if (cat === "Categoria") return;
            const opt = `<option value="${cat}">${cat}</option>`;
            catSelect.innerHTML += opt;
            filterCat.innerHTML += opt;
        });
    } catch (e) {
        console.error("Error cargando categorias.json:", e);
    }
}

// --- NAVEGACIÓN CORREGIDA ---
function updateActiveNavLink(id) {
    document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
    const link = document.getElementById(id);
    if (link) link.classList.add('active');
}

const toggleView = (showForm) => {
    document.getElementById('view-mantenimiento').classList.add('hidden');
    document.getElementById('view-dashboard').classList.add('hidden');

    if (showForm) {
        document.getElementById('view-table').classList.add('hidden');
        document.getElementById('view-form').classList.remove('hidden');

        if (!editingTicketId) {
            document.getElementById('form-title').innerText = "Nueva Solicitud";
            document.querySelector('.ticket-id-field-container').classList.add('hidden'); // Ocultar para nueva solicitud
            document.getElementById('f-codigo').value = ""; 
            document.getElementById('pro-ticket-form').reset();
            formDirty = false;
            document.getElementById('f-asunto').value = ""; // Limpieza explícita
            quill.setContents([]); // Limpiar editor
            document.getElementById('tabs-container').classList.add('hidden');
            showTab('details-section');
            // Asegurarse de que el solicitante se cargue para nuevas solicitudes
            setRandomUser();
        }
    } else {
        editingTicketId = null;
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
    const mant = document.getElementById('view-mantenimiento');
    mant.classList.remove('hidden');
    updateActiveNavLink('nav-inicio-link');

    document.getElementById('count-total').innerText = allTickets.length;
    document.getElementById('count-pending').innerText = allTickets.filter(t => !['Resuelto', 'Cerrado'].includes(t.estado)).length;
    document.getElementById('count-resolved').innerText = allTickets.filter(t => t.estado === 'Resuelto').length;
}

function showDashboard() {
    document.getElementById('view-table').classList.add('hidden');
    document.getElementById('view-form').classList.add('hidden');
    document.getElementById('view-mantenimiento').classList.add('hidden');
    document.getElementById('view-dashboard').classList.remove('hidden');
    updateActiveNavLink('nav-dashboard-link');
    initCharts();
}

// Eventos de Navegación
document.getElementById('show-form-btn').onclick = () => toggleView(true);
document.getElementById('nav-add-ticket').onclick = () => toggleView(true);
document.getElementById('cancel-form-btn').onclick = () => toggleView(false);
document.getElementById('close-form-btn').onclick = () => toggleView(false);

document.querySelectorAll('.nav-links a')[0].onclick = (e) => { e.preventDefault(); showInicio(); };
document.querySelectorAll('.nav-links a')[1].onclick = (e) => { e.preventDefault(); showDashboard(); };
document.getElementById('nav-solicitudes-link').onclick = (e) => { e.preventDefault(); toggleView(false); };

// Botón Restablecer manual para proteger al solicitante
document.getElementById('reset-form-btn').onclick = () => {
    const solicitanteActual = document.getElementById('f-solicitante').value;
    const photoActual = document.getElementById('user-photo').src;
    document.getElementById('pro-ticket-form').reset();
    quill.setContents([]);
    document.getElementById('f-solicitante').value = solicitanteActual;
    document.getElementById('user-photo').src = photoActual;
};

// --- LÓGICA DE CASCADA ---
const catSelect = document.getElementById('f-categoria');
const subSelect = document.getElementById('f-subcategoria');
const artSelect = document.getElementById('f-articulo');

catSelect.onchange = () => {
    const cat = catSelect.value;
    subSelect.innerHTML = '<option value="">Seleccione...</option>';
    artSelect.innerHTML = '<option value="">Seleccione subcategoría...</option>';
    subSelect.disabled = !cat;
    artSelect.disabled = true;

    if (cat && categoriasData[cat]) {
        Object.keys(categoriasData[cat]).forEach(sub => {
            subSelect.innerHTML += `<option value="${sub}">${sub}</option>`;
        });
    }
};

subSelect.onchange = () => {
    const cat = catSelect.value;
    const sub = subSelect.value;
    artSelect.innerHTML = '<option value="">Seleccione...</option>';
    artSelect.disabled = !sub;

    if (cat && sub && categoriasData[cat][sub]) {
        categoriasData[cat][sub].forEach(art => {
            artSelect.innerHTML += `<option value="${art}">${art}</option>`;
        });
    }
};

// --- API Y FILTROS ---
async function cargarTickets() {
    try {
        const res = await fetch('http://localhost:8001/tickets');
        if (!res.ok) throw new Error("Error en la respuesta del servidor");
        allTickets = await res.json();
        console.log("Tickets cargados desde la API:", allTickets.length, "tickets.");
        aplicarFiltros();
    } catch (e) { 
        console.error("Error cargando tickets:", e);
        alert("Error al cargar tickets desde la API. Revisa la consola para más detalles.");
    }
}

function aplicarFiltros() {
    const term = document.getElementById('nav-search-input').value.toLowerCase();
    const prioFilter = document.getElementById('filter-priority').value;
    const catFilter = document.getElementById('filter-category').value;

    const filtrados = allTickets.filter(t => {
        const matchSearch = (t.asunto || "").toLowerCase().includes(term) || (t.solicitante || "").toLowerCase().includes(term);
        const estado = (t.estado || 'Abierto').toLowerCase();
        const matchPrio = prioFilter ? t.prioridad === prioFilter : true;
        const matchCat = catFilter ? t.categoria === catFilter : true;
        let matchView = false;

        if (currentFilter === 'todas') matchView = true;
        else if (currentFilter === 'pendientes') matchView = ['abierto', 'asignado', 'en espera', 'en progreso'].includes(estado);
        else if (currentFilter === 'cerradas') matchView = ['resuelto', 'cerrado'].includes(estado);
        
        // Debugging filters (descomenta estas líneas para ver el detalle de cada ticket en la consola)
        // console.log(`Ticket ID: ${t['ID-SERVDESK'] || t._id}, Asunto: ${t.asunto}, Estado: ${t.estado}, Prioridad: ${t.prioridad}, Categoría: ${t.categoria}`);
        // console.log(`  matchSearch: ${matchSearch}, matchView: ${matchView}, matchPrio: ${matchPrio}, matchCat: ${matchCat}`);

        return matchSearch && matchView && matchPrio && matchCat;
    });
    console.log("Tickets filtrados para mostrar:", filtrados.length, "tickets.");
    renderTable(filtrados);
}
// --- RENDERIZADO DE TABLA (Prioridad con Color) ---
function renderTable(data) {
    const tbody = document.getElementById('tickets-body');
    const countLabel = document.getElementById('ticket-count');
    const emptyState = document.getElementById('empty-state-container');
    const table = document.querySelector('.zoho-table');

    tbody.innerHTML = '';
    countLabel.innerText = `${data.length} Resultados`;
    
    // Manejo de estado vacío si no hay tickets que mostrar
    if (data.length === 0) {
        emptyState.classList.remove('hidden');
        table.classList.add('hidden');
        return;
    } else {
        emptyState.classList.add('hidden');
        table.classList.remove('hidden');
    }

    data.forEach(t => {
        const ticketDisplayId = t['ID-ITIL'] || `#${String(t._id).slice(-5)}`;
        const fecha = t.fecha_creacion ? new Date(t.fecha_creacion).toLocaleDateString() : '--';
        const prioClass = t.prioridad === 'Alta' ? 'prio-alta' : t.prioridad === 'Normal' ? 'prio-normal' : 'prio-baja';
        
        tbody.innerHTML += `
            <tr class="animate-in clickable-row" onclick="prepararEdicion('${t._id}')">
                <td>${ticketDisplayId}</td>
                <td style="color:var(--zoho-blue); font-weight:600;">${t.asunto}</td>
                <td>${t.solicitante}</td>
                <td><span class="status-pill">${t.estado || 'Abierto'}</span></td>
                <td><span class="prio-tag ${prioClass}">${t.prioridad}</span></td>
                <td>${fecha}</td>
                <td class="actions-cell" onclick="event.stopPropagation()">
                    <i class="fa-solid fa-pen-to-square edit-btn" onclick="prepararEdicion('${t._id}')" title="Ver Detalles/Editar"></i>
                    <i class="fa-solid fa-trash delete-btn" onclick="eliminarTicket('${t._id}')" title="Eliminar"></i>
                </td>
            </tr>`;
    });
}

// --- CREACIÓN DE TICKET (POST CORREGIDO) ---
document.getElementById('pro-ticket-form').onsubmit = async (e) => {
    e.preventDefault();
    
    const estado = document.getElementById('f-estado').value;
    const resolucion = document.getElementById('f-resolucion').value.trim();
    const cat = document.getElementById('f-categoria').value;
    const sub = document.getElementById('f-subcategoria').value;
    const art = document.getElementById('f-articulo').value;
    const asunto = document.getElementById('f-asunto').value.trim();
    const modo = document.getElementById('f-modo').value;
    const sucursal = document.getElementById('f-sucursal').value;

    // Validaciones de obligatoriedad (Excepto descripción)
    if (!cat || !sub || !art || !asunto || !modo || !sucursal) {
        alert("⚠️ Por favor, completa todos los campos obligatorios en la pestaña de Detalles.");
        showTab('details-section');
        return;
    }

    if (estado === "Resuelto" && !resolucion) {
        alert("⚠️ Debe incluir una resolución para marcar el ticket como Resuelto.");
        showTab('resolution-section');
        return;
    }

    const data = {
        solicitante: document.getElementById('f-solicitante').value,
        tipo_solicitud: document.getElementById('f-tipo').value,
        prioridad: isResolutionSave ? (estado === 'Cerrado' ? 'Cerrado' : 'Normal') : document.getElementById('f-prioridad').value,
        estado: isResolutionSave ? (estado === 'Cerrado' ? 'Cerrado' : 'Resuelto') : estado,
        modo: document.getElementById('f-modo').value,
        sucursal: document.getElementById('f-sucursal').value,
        categoria: document.getElementById('f-categoria').value,
        subcategoria: document.getElementById('f-subcategoria').value,
        articulo: document.getElementById('f-articulo').value,
        asunto: document.getElementById('f-asunto').value,
        descripcion_html: quill.root.innerHTML,
        resolucion: resolucion
    };

    try {
        const url = editingTicketId 
            ? `http://localhost:8001/tickets/${editingTicketId}` 
            : 'http://localhost:8001/tickets';
        
        const res = await fetch(url, {
            method: editingTicketId ? 'PUT' : 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });

        if(res.ok) {
            const responseData = await res.json(); // Obtener el ticket completo de la respuesta
            alert(editingTicketId ? "✅ Ticket actualizado" : "✅ Ticket creado");
            
            if (editingTicketId) {
                // Reemplazar el ticket actualizado en allTickets
                const index = allTickets.findIndex(t => t._id === editingTicketId);
                if (index !== -1) {
                    allTickets[index] = responseData;
                }
            } else {
                // Añadir el nuevo ticket a allTickets
                allTickets.unshift(responseData); // Añadir al principio para que aparezca primero
            }
            editingTicketId = null;
            isResolutionSave = false;
            toggleView(false); 
        } else {
            const errData = await res.json();
            console.error("Error detallado:", errData);
            alert("❌ Error de validación. Revisa la consola.");
        }
    } catch (err) {
        console.error("Error de conexión:", err);
        alert("❌ No se pudo conectar con el servidor API");
    }
};

// --- FUNCIONES DE ACCIÓN ---
async function eliminarTicket(id) {
    if (!confirm("¿Estás seguro de que deseas eliminar este ticket?")) return;
    
    try {
        const res = await fetch(`http://localhost:8001/tickets/${id}`, { method: 'DELETE' });
        if (res.ok) {
            cargarTickets();
        }
    } catch (err) {
        console.error("Error al eliminar:", err);
    }
}

function prepararEdicion(id) {
    const ticket = allTickets.find(t => t._id === id);
    if (!ticket) return;

    editingTicketId = id;
    const ticketCode = ticket['ID-ITIL'] || `#${id.slice(-5)}`; 
    document.getElementById('form-title').innerText = `Editar: ${ticketCode}`; // Actualizar el título del formulario
    document.getElementById('tabs-container').classList.remove('hidden');
    
    // Llenar campos básicos
    document.querySelector('.ticket-id-field-container').classList.remove('hidden'); 
    document.getElementById('f-codigo').value = ticket['ID-ITIL'] || "Asignando código..."; 
    document.getElementById('f-solicitante').value = ticket.solicitante;
    document.getElementById('f-tipo').value = ticket.tipo_solicitud;
    document.getElementById('f-prioridad').value = ticket.prioridad;
    document.getElementById('f-estado').value = ticket.estado;
    document.getElementById('f-modo').value = ticket.modo || "";
    document.getElementById('f-sucursal').value = ticket.sucursal || "";
    document.getElementById('f-asunto').value = ticket.asunto;
    document.getElementById('f-resolucion').value = ticket.resolucion || "";
    
    // Cargar Descripción en Quill
    if (ticket.descripcion_html) {
        quill.root.innerHTML = ticket.descripcion_html;
    } else {
        quill.setContents([]);
    }

    // Lógica de cascada para categorías
    if (ticket.categoria) {
        const catSel = document.getElementById('f-categoria');
        catSel.value = ticket.categoria;
        catSel.onchange(); // Disparar carga de subcategorías

        if (ticket.subcategoria) {
            const subSel = document.getElementById('f-subcategoria');
            subSel.value = ticket.subcategoria;
            subSel.onchange(); // Disparar carga de artículos

            if (ticket.articulo) {
                document.getElementById('f-articulo').value = ticket.articulo;
            }
        }
    }

    showTab('details-section');

    // Mostrar vista de formulario
    document.getElementById('view-table').classList.add('hidden');
    document.getElementById('view-form').classList.remove('hidden');
}

// --- LÓGICA DE TABS ---
function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    document.getElementById(tabId).classList.remove('hidden');
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');

    // Si estamos en resolución, el botón de guardar cambia su comportamiento
    const saveBtn = document.querySelector('.btn-save');
    if (tabId === 'resolution-section') {
        saveBtn.innerText = "Guardar Resolución";
        isResolutionSave = true;
    } else {
        saveBtn.innerText = editingTicketId ? "Actualizar Solicitud" : "Agregar solicitud";
        isResolutionSave = false;
    }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => showTab(btn.dataset.tab);
});

// --- DRAG & DROP ---
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('f-adjunto');
const fileNameDisplay = document.getElementById('file-name-display');

dropZone.onclick = () => fileInput.click();

dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
};

dropZone.ondragleave = () => dropZone.classList.remove('dragover');

dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        handleFiles(e.dataTransfer.files);
    }
};

fileInput.onchange = () => handleFiles(fileInput.files);

function handleFiles(files) {
    if (files.length > 0) {
        fileNameDisplay.innerText = `Archivo seleccionado: ${files[0].name}`;
    }
}

// --- OTROS EVENTOS ---
document.getElementById('nav-search-input').oninput = (e) => {
    const isFormVisible = !document.getElementById('view-form').classList.contains('hidden');
    if (isFormVisible) {
        if (formDirty && !confirm("¿Seguro que quieres salir? Los cambios no guardados se perderán.")) {
            e.target.value = "";
            return;
        }
        toggleView(false);
    }
    aplicarFiltros();
};

document.getElementById('current-view-trigger').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('view-menu').classList.toggle('hidden');
};

document.querySelectorAll('#view-menu li').forEach(li => {
    li.onclick = function() {
        currentFilter = this.dataset.view;
        document.getElementById('view-title').innerText = this.innerText;
        document.getElementById('view-menu').classList.add('hidden');
        aplicarFiltros();
    }
});

window.onclick = () => document.getElementById('view-menu').classList.add('hidden');

// Detectar cambios en formulario
document.getElementById('pro-ticket-form').onchange = () => formDirty = true;
quill.on('text-change', () => formDirty = true);

// --- TEMA OSCURO ---
const themeToggle = document.getElementById('theme-toggle');
themeToggle.onclick = () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    themeToggle.classList.replace(isDark ? 'fa-moon' : 'fa-sun', isDark ? 'fa-sun' : 'fa-moon');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
        
        // Actualizar gráficas si están visibles
        if (!document.getElementById('view-dashboard').classList.contains('hidden')) {
            initCharts();
        }
};

if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark-mode');
    themeToggle.classList.replace('fa-moon', 'fa-sun');
}

// Usuario Aleatorio Inicial
async function setRandomUser() {
    try {
        // Limpiamos el input y la foto mientras carga para dar feedback visual
        const photoImg = document.getElementById('user-photo');
        const solicitanteInput = document.getElementById('f-solicitante');
        
        solicitanteInput.value = "Cargando...";
        
        const randomId = Math.floor(Math.random() * 150) + 1;
        const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${randomId}`);
        const pokemon = await res.json();
        
        const nombre = pokemon.name.toUpperCase();
        
        // Asignar al formulario
        solicitanteInput.value = nombre;
        
        // Asignar a la Navbar
        const avatarUrl = `https://api.dicebear.com/7.x/avataaars/svg?seed=${nombre}`;
        photoImg.src = avatarUrl;
        
    } catch (e) {
        console.error("Error al obtener Pokemon:", e);
        document.getElementById('f-solicitante').value = "USUARIO SOPORTE";
    }
}

// Eventos de filtros adicionales
document.getElementById('filter-priority').onchange = aplicarFiltros;
document.getElementById('filter-category').onchange = aplicarFiltros;

// --- LÓGICA DE GRÁFICAS (Chart.js) ---
function initCharts() {
    const isDark = document.body.classList.contains('dark-mode');
    const textColor = isDark ? '#94a3b8' : '#666';
    const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';

    Chart.defaults.color = textColor;

    const ctx1 = document.getElementById('chart-metrics').getContext('2d');
    const metric = document.getElementById('dashboard-metric').value;
    
    // Destruir previas si existen
    if(charts.metric) charts.metric.destroy();

    const dataMap = {};
    allTickets.forEach(t => {
        const key = t[metric] || 'Sin definir';
        dataMap[key] = (dataMap[key] || 0) + 1;
    });

    charts.metric = new Chart(ctx1, {
        type: 'doughnut',
        data: {
            labels: Object.keys(dataMap),
            datasets: [{ 
                data: Object.values(dataMap), 
                backgroundColor: [
                    'hsl(217, 100%, 50%)', 
                    'hsl(35, 92%, 50%)', 
                    'hsl(160, 84%, 39%)', 
                    'hsl(0, 84%, 60%)', 
                    'hsl(245, 82%, 67%)'
                ],
                borderWidth: 0,
                hoverOffset: 15
            }]
        },
        options: {
            cutout: '70%',
            plugins: {
                legend: { position: 'bottom', labels: { padding: 20, usePointStyle: true, font: { family: 'Outfit', size: 12 } } }
            }
        }
    });

    // Gráfica de Barras Diarias (Apiladas) con Gradiente
    const ctx2 = document.getElementById('chart-daily-status').getContext('2d');
    if(charts.daily) charts.daily.destroy();

    const gradBlue = ctx2.createLinearGradient(0, 0, 0, 400);
    gradBlue.addColorStop(0, 'rgba(0, 103, 255, 0.8)');
    gradBlue.addColorStop(1, 'rgba(0, 103, 255, 0.1)');

    const gradGreen = ctx2.createLinearGradient(0, 0, 0, 400);
    gradGreen.addColorStop(0, 'rgba(16, 185, 129, 0.8)');
    gradGreen.addColorStop(1, 'rgba(16, 185, 129, 0.1)');

    charts.daily = new Chart(ctx2, {
        type: 'bar',
        data: {
            labels: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie'],
            datasets: [
                { label: 'Cerrados', data: [5, 8, 4, 10, 6], backgroundColor: gradGreen, borderRadius: 6 },
                { label: 'Resueltos', data: [3, 2, 7, 5, 8], backgroundColor: gradBlue, borderRadius: 6 }
            ]
        },
        options: { 
            responsive: true,
            scales: { 
                x: { stacked: true, grid: { display: false } }, 
                y: { stacked: true, grid: { color: gridColor } } 
            },
            plugins: { legend: { position: 'bottom', labels: { usePointStyle: true } } }
        }
    });

    // Historial (Simulado con datos reales si hubiera fechas)
    renderHistoryChart('chart-history-received', '#0067ff', 'Recibidos', textColor, gridColor);
    renderHistoryChart('chart-history-resolved', '#10b981', 'Resueltos', textColor, gridColor);
}

function renderHistoryChart(id, color, label, textColor, gridColor) {
    const ctx = document.getElementById(id).getContext('2d');
    if(charts[id]) charts[id].destroy();

    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, color.replace(')', ', 0.3)').replace('rgb', 'rgba').replace('hsl', 'hsla'));
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

    charts[id] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array.from({length: 15}, (_, i) => i + 1),
            datasets: [{
                label: label,
                data: Array.from({length: 15}, () => Math.floor(Math.random() * 20)),
                borderColor: color,
                backgroundColor: gradient,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 6,
                borderWidth: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false }, ticks: { color: textColor, font: { family: 'Outfit' } } },
                y: { grid: { color: gridColor }, ticks: { color: textColor, font: { family: 'Outfit' } } }
            },
            plugins: { 
                legend: { display: false },
                tooltip: { backgroundColor: 'rgba(15, 23, 42, 0.9)', titleFont: { family: 'Outfit' }, bodyFont: { family: 'Outfit' } }
            }
        }
    });
}

document.getElementById('dashboard-metric').onchange = initCharts;

// Inicialización
async function initApp() {
    try {
        await cargarCategorias(); 
        setRandomUser();
        // Cargamos tickets al final, si falla no bloquea el resto
        await cargarTickets();    
        showInicio();             // Mover aquí para que allTickets esté poblado
    } catch (err) {
        console.warn("La inicialización tuvo problemas con la API, pero la interfaz está lista.");
    }
}

initApp();