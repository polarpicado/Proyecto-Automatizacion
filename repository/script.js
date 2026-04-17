const API_BASE_URL = window.REPOSITORY_CONFIG?.apiBaseUrl || 'https://caritive-corrosively-natalia.ngrok-free.dev/api';

const elements = {
  fileInput: document.getElementById('file-input'),
  dropzone: document.getElementById('dropzone'),
  uploadBtn: document.getElementById('upload-btn'),
  uploadFeedback: document.getElementById('upload-feedback'),
  fileList: document.getElementById('file-list'),
  emptyState: document.getElementById('empty-state'),
  searchInput: document.getElementById('search-input'),
  fileCount: document.getElementById('file-count'),
  toastContainer: document.getElementById('toast-container')
};

let selectedFiles = [];
let repositoryFiles = [];

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div>${message}</div>
    <button type="button" aria-label="Cerrar notificación">&times;</button>
  `;

  const removeToast = () => {
    toast.classList.add('removing');
    window.setTimeout(() => toast.remove(), 180);
  };

  toast.querySelector('button').onclick = removeToast;
  elements.toastContainer.appendChild(toast);
  window.setTimeout(removeToast, 3800);
}

function refreshUploadFeedback() {
  if (!selectedFiles.length) {
    elements.uploadFeedback.textContent = 'Todavía no has seleccionado archivos.';
    return;
  }
  elements.uploadFeedback.textContent = `${selectedFiles.length} archivo(s) listos para subir.`;
}

function renderFiles() {
  const term = elements.searchInput.value.trim().toLowerCase();
  const files = repositoryFiles.filter((file) => !term || file.name.toLowerCase().includes(term));

  elements.fileCount.textContent = String(repositoryFiles.length);
  elements.emptyState.classList.toggle('hidden', files.length > 0);
  elements.fileList.innerHTML = files.map((file) => `
    <article class="file-card">
      <div>
        <h3>${file.original_name}</h3>
        <p>${formatDate(file.modified_at)} · ${formatSize(file.size)}</p>
      </div>
      <div class="file-actions">
        <a href="${apiUrl(file.url)}" target="_blank" rel="noopener">Descargar</a>
        <button type="button" onclick="deleteRepositoryFile('${encodeURIComponent(file.name)}')">Eliminar</button>
      </div>
    </article>
  `).join('');
}

async function loadFiles() {
  try {
    const response = await fetch(apiUrl('/repository/files'));
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'No se pudieron cargar los archivos.');
    repositoryFiles = data.files || [];
    renderFiles();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'No se pudieron cargar los archivos.', 'error');
  }
}

async function uploadFiles() {
  if (!selectedFiles.length) {
    showToast('Selecciona al menos un archivo antes de subirlo.', 'error');
    return;
  }

  const formData = new FormData();
  selectedFiles.forEach((file) => formData.append('files', file));

  try {
    const response = await fetch(apiUrl('/repository/files'), {
      method: 'POST',
      body: formData
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'No se pudieron subir los archivos.');
    selectedFiles = [];
    elements.fileInput.value = '';
    refreshUploadFeedback();
    showToast(`${data.count} archivo(s) subidos con éxito.`, 'success');
    await loadFiles();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'No se pudieron subir los archivos.', 'error');
  }
}

async function deleteRepositoryFile(encodedName) {
  try {
    const response = await fetch(apiUrl(`/repository/files/${encodedName}`), { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'No se pudo eliminar el archivo.');
    showToast(data.msg || 'Archivo eliminado con éxito.', 'success');
    await loadFiles();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'No se pudo eliminar el archivo.', 'error');
  }
}
window.deleteRepositoryFile = deleteRepositoryFile;

function handleSelectedFiles(files) {
  selectedFiles = Array.from(files || []);
  refreshUploadFeedback();
}

elements.fileInput.addEventListener('change', () => handleSelectedFiles(elements.fileInput.files));
elements.uploadBtn.addEventListener('click', uploadFiles);
elements.searchInput.addEventListener('input', renderFiles);

elements.dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.dropzone.classList.add('dragover');
});

elements.dropzone.addEventListener('dragleave', () => {
  elements.dropzone.classList.remove('dragover');
});

elements.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  elements.dropzone.classList.remove('dragover');
  handleSelectedFiles(event.dataTransfer.files);
});

loadFiles();
