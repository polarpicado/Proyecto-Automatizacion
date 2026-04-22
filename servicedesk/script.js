const API_BASE_URL = window.SERVICEDESK_CONFIG?.apiBaseUrl || 'https://caritive-corrosively-natalia.ngrok-free.dev/api';
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
let allSolutions = [];
let editingSolutionId = null;
let currentSolutionFolder = '';
let ticketsLoadPromise = null;
let animateRowsOnNextRender = true;

const RICH_TEXT_FONTS = [
    { value: 'arial', label: 'Arial', family: 'Arial, sans-serif' },
    { value: 'calibri', label: 'Calibri', family: 'Calibri, Candara, Segoe, sans-serif' },
    { value: 'comic-sans', label: 'Comic Sans', family: '"Comic Sans MS", "Comic Sans", cursive' },
    { value: 'courier-new', label: 'Courier New', family: '"Courier New", monospace' },
    { value: 'georgia', label: 'Georgia', family: 'Georgia, serif' },
    { value: 'roboto', label: 'Roboto', family: '"Roboto", sans-serif' },
    { value: 'serif', label: 'Serif', family: 'serif' },
    { value: 'tahoma', label: 'Tahoma', family: 'Tahoma, Geneva, sans-serif' },
    { value: 'times-new-roman', label: 'Times New Roman', family: '"Times New Roman", serif' },
    { value: 'trebuchet', label: 'Trebuchet', family: '"Trebuchet MS", sans-serif' },
    { value: 'verdana', label: 'Verdana', family: 'Verdana, Geneva, sans-serif' }
];
const RICH_TEXT_SIZES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 24, 36];
const EMOJI_OPTIONS = ['😀', '😁', '😂', '😊', '😍', '🤔', '😎', '😢', '😡', '👍', '👎', '👏', '🙏', '🎉', '🔥', '💡', '📌', '📎', '✅', '⚠️'];

const FontFormat = Quill.import('formats/font');
FontFormat.whitelist = RICH_TEXT_FONTS.map((font) => font.value);
Quill.register(FontFormat, true);

const SizeStyle = Quill.import('attributors/style/size');
SizeStyle.whitelist = RICH_TEXT_SIZES.map((size) => `${size}px`);
Quill.register(SizeStyle, true);

const BlockEmbed = Quill.import('blots/block/embed');

class ServiceDeskTableBlot extends BlockEmbed {
    static create(value) {
        const node = super.create();
        node.setAttribute('contenteditable', 'true');
        node.classList.add('sd-table-embed');
        node.innerHTML = typeof value === 'string' ? value : value?.html || '';
        node.querySelectorAll('td, th').forEach((cell) => {
            cell.setAttribute('contenteditable', 'true');
        });
        return node;
    }

    static value(node) {
        return node.innerHTML;
    }
}

ServiceDeskTableBlot.blotName = 'sd-table';
ServiceDeskTableBlot.tagName = 'div';
ServiceDeskTableBlot.className = 'sd-table-embed';
Quill.register(ServiceDeskTableBlot);

class ServiceDeskImageBlot extends BlockEmbed {
    static create(value) {
        const node = super.create();
        const src = typeof value === 'string' ? value : value?.src || '';
        const mode = value?.mode || 'fit';
        node.setAttribute('contenteditable', 'false');
        node.classList.add('sd-image-embed');
        node.dataset.src = src;
        node.dataset.mode = mode;
        node.innerHTML = `
            <figure class="sd-image-figure sd-image-${mode}">
                <img src="${escapeHtml(src)}" alt="Imagen insertada">
            </figure>
        `;
        return node;
    }

    static value(node) {
        return {
            src: node.dataset.src || '',
            mode: node.dataset.mode || 'fit'
        };
    }
}

ServiceDeskImageBlot.blotName = 'sd-image';
ServiceDeskImageBlot.tagName = 'div';
ServiceDeskImageBlot.className = 'sd-image-embed';
Quill.register(ServiceDeskImageBlot);

let activeEditorPopover = null;

function closeEditorPopover() {
    if (!activeEditorPopover) return;
    activeEditorPopover.cleanup?.();
    activeEditorPopover.element.remove();
    activeEditorPopover = null;
}

function buildColorPalette() {
    const colors = [];
    for (let row = 0; row < 10; row += 1) {
        for (let col = 0; col < 10; col += 1) {
            const hue = col * 36;
            const lightness = 18 + (row * 7);
            colors.push(`hsl(${hue}, 78%, ${lightness}%)`);
        }
    }
    colors[11] = '#6b7280';
    return colors;
}

const COLOR_PALETTE = buildColorPalette();

function withEditorRange(quill, callback) {
    quill.focus();
    const range = quill.getSelection(true) || { index: quill.getLength(), length: 0 };
    callback(range);
}

function getTableSelectionContext(quill) {
    const browserSelection = window.getSelection();
    if (!browserSelection || browserSelection.rangeCount === 0) return null;

    const anchorNode = browserSelection.anchorNode;
    if (!anchorNode) return null;

    const element = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement;
    const cell = element?.closest?.('.sd-table-embed td, .sd-table-embed th');
    if (!cell || !quill.root.contains(cell)) return null;

    return { selection: browserSelection, cell };
}

function formatTableSelection(command, value = null) {
    document.execCommand('styleWithCSS', false, true);
    if (value === null) {
        document.execCommand(command, false);
    } else {
        document.execCommand(command, false, value);
    }
}

function openEditorPopover(anchor, content, { className = '' } = {}) {
    closeEditorPopover();
    const popover = document.createElement('div');
    popover.className = `editor-popover ${className}`.trim();
    popover.appendChild(content);
    document.body.appendChild(popover);

    const rect = anchor.getBoundingClientRect();
    const top = rect.bottom + window.scrollY + 8;
    const left = Math.max(12, rect.left + window.scrollX - 10);
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;

    const outsideClickHandler = (event) => {
        if (!popover.contains(event.target) && !anchor.contains(event.target)) {
            closeEditorPopover();
        }
    };

    const escapeHandler = (event) => {
        if (event.key === 'Escape') {
            closeEditorPopover();
        }
    };

    const cleanup = () => {
        document.removeEventListener('mousedown', outsideClickHandler);
        document.removeEventListener('keydown', escapeHandler);
    };

    document.addEventListener('mousedown', outsideClickHandler);
    document.addEventListener('keydown', escapeHandler);
    activeEditorPopover = { element: popover, cleanup };
    return popover;
}

function createPalettePopover(quill, anchor, formatName) {
    const content = document.createElement('div');
    content.className = 'editor-palette';
    content.innerHTML = `
        <div class="editor-palette-header">
            <strong>${formatName === 'color' ? 'Color de fuente' : 'Color de fondo'}</strong>
            <button type="button" class="editor-clear-btn">Quitar</button>
        </div>
        <div class="editor-color-grid">
            ${COLOR_PALETTE.map((color) => `
                <button
                    type="button"
                    class="editor-color-swatch"
                    data-color="${color}"
                    style="background:${color}"
                    aria-label="${color}"
                ></button>
            `).join('')}
        </div>
    `;

    content.querySelector('.editor-clear-btn').onclick = () => {
        if (getTableSelectionContext(quill)) {
            formatTableSelection(formatName === 'color' ? 'foreColor' : 'hiliteColor', 'inherit');
        } else {
            quill.format(formatName, false, 'user');
        }
        closeEditorPopover();
    };

    content.querySelectorAll('[data-color]').forEach((button) => {
        button.onclick = () => {
            if (getTableSelectionContext(quill)) {
                formatTableSelection(formatName === 'color' ? 'foreColor' : 'hiliteColor', button.dataset.color);
            } else {
                quill.format(formatName, button.dataset.color, 'user');
            }
            closeEditorPopover();
        };
    });

    openEditorPopover(anchor, content);
}

function createEmojiPopover(quill, anchor) {
    const content = document.createElement('div');
    content.className = 'editor-emoji-picker';
    content.innerHTML = EMOJI_OPTIONS.map((emoji) => `
        <button type="button" class="editor-emoji-btn" data-emoji="${emoji}">${emoji}</button>
    `).join('');

    content.querySelectorAll('[data-emoji]').forEach((button) => {
        button.onclick = () => {
            withEditorRange(quill, (range) => {
                quill.insertText(range.index, button.dataset.emoji, 'user');
                quill.setSelection(range.index + button.dataset.emoji.length, 0, 'user');
            });
            closeEditorPopover();
        };
    });

    openEditorPopover(anchor, content);
}

function createLinkPopover(quill, anchor) {
    const selectedText = (quill.getText((quill.getSelection() || {}).index || 0, (quill.getSelection() || {}).length || 0) || '').trim();
    const content = document.createElement('form');
    content.className = 'editor-popover-form';
    content.innerHTML = `
        <label>
            URL
            <input type="url" name="url" placeholder="https://ejemplo.com" required>
        </label>
        <label>
            Texto
            <input type="text" name="text" placeholder="Texto del enlace" value="${escapeHtml(selectedText)}">
        </label>
        <div class="editor-popover-actions">
            <button type="button" class="btn-reset editor-popover-cancel">Cancelar</button>
            <button type="submit" class="btn-save">Insertar enlace</button>
        </div>
    `;

    content.querySelector('.editor-popover-cancel').onclick = () => closeEditorPopover();
    content.onsubmit = (event) => {
        event.preventDefault();
        const formData = new FormData(content);
        const url = String(formData.get('url') || '').trim();
        const text = String(formData.get('text') || '').trim();
        if (!url) return;

        if (getTableSelectionContext(quill)) {
            if (window.getSelection()?.toString().trim()) {
                formatTableSelection('createLink', url);
            } else {
                document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text || url)}</a>`);
            }
        } else {
            withEditorRange(quill, (range) => {
                if (range.length > 0) {
                    quill.format('link', url, 'user');
                } else {
                    const linkText = text || url;
                    quill.insertText(range.index, linkText, { link: url }, 'user');
                    quill.setSelection(range.index + linkText.length, 0, 'user');
                }
            });
        }

        closeEditorPopover();
    };

    openEditorPopover(anchor, content, { className: 'editor-popover-wide' });
}

function buildTableNode(rows, cols) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sd-table-embed';

    const scroll = document.createElement('div');
    scroll.className = 'sd-table-scroll';

    const table = document.createElement('table');
    table.className = 'sd-editor-table';
    const tbody = document.createElement('tbody');

    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
        const row = document.createElement('tr');
        for (let colIndex = 0; colIndex < cols; colIndex += 1) {
            const cell = document.createElement('td');
            cell.setAttribute('contenteditable', 'true');
            cell.appendChild(document.createElement('br'));
            row.appendChild(cell);
        }
        tbody.appendChild(row);
    }

    table.appendChild(tbody);
    scroll.appendChild(table);
    wrapper.appendChild(scroll);
    return wrapper;
}

function insertEditableNodeAtCursor(quill, node) {
    quill.focus();

    const browserSelection = window.getSelection();
    let nativeRange = browserSelection && browserSelection.rangeCount > 0
        ? browserSelection.getRangeAt(0)
        : null;

    if (!nativeRange || !quill.root.contains(nativeRange.startContainer)) {
        const quillRange = quill.getSelection(true) || { index: quill.getLength(), length: 0 };
        quill.setSelection(quillRange.index, quillRange.length, 'silent');
        nativeRange = browserSelection && browserSelection.rangeCount > 0
            ? browserSelection.getRangeAt(0)
            : null;
    }

    if (!nativeRange) return;

    nativeRange.deleteContents();
    nativeRange.insertNode(node);

    const firstCell = node.querySelector('td, th');
    if (firstCell) {
        const cellRange = document.createRange();
        cellRange.selectNodeContents(firstCell);
        cellRange.collapse(true);
        browserSelection.removeAllRanges();
        browserSelection.addRange(cellRange);
    } else {
        const afterRange = document.createRange();
        afterRange.setStartAfter(node);
        afterRange.collapse(true);
        browserSelection.removeAllRanges();
        browserSelection.addRange(afterRange);
    }

    quill.update('silent');
}

function createTablePopover(quill, anchor) {
    const content = document.createElement('form');
    content.className = 'editor-popover-form';
    content.innerHTML = `
        <label>
            Alto
            <input type="number" name="rows" min="1" max="12" value="2" required>
        </label>
        <label>
            Ancho
            <input type="number" name="cols" min="1" max="12" value="2" required>
        </label>
        <div class="editor-popover-note">Usaremos Alto como filas y Ancho como columnas.</div>
        <div class="editor-popover-actions">
            <button type="button" class="btn-reset editor-popover-cancel">Cancelar</button>
            <button type="submit" class="btn-save">Insertar tabla</button>
        </div>
    `;

    content.querySelector('.editor-popover-cancel').onclick = () => closeEditorPopover();
    content.onsubmit = (event) => {
        event.preventDefault();
        const formData = new FormData(content);
        const rows = Math.min(12, Math.max(1, Number(formData.get('rows') || 2)));
        const cols = Math.min(12, Math.max(1, Number(formData.get('cols') || 2)));

        insertEditableNodeAtCursor(quill, buildTableNode(rows, cols));

        closeEditorPopover();
    };

    openEditorPopover(anchor, content);
}

function imageModeStyle(mode) {
    switch (mode) {
        case 'small':
            return 'width:180px; max-width:180px;';
        case 'original':
            return 'width:auto; max-width:none;';
        case 'page':
            return 'width:100%; max-width:100%;';
        default:
            return 'max-width:420px; width:100%;';
    }
}

function insertImageEmbed(quill, src, mode) {
    withEditorRange(quill, (range) => {
        quill.insertEmbed(range.index, 'sd-image', { src, mode }, 'user');
        quill.insertText(range.index + 1, '\n', 'user');
        quill.setSelection(range.index + 2, 0, 'user');
    });
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('No se pudo leer la imagen seleccionada.'));
        reader.readAsDataURL(file);
    });
}

function createImagePopover(quill, anchor) {
    const content = document.createElement('form');
    content.className = 'editor-popover-form';
    content.innerHTML = `
        <div class="editor-toggle-group">
            <label><input type="radio" name="sourceType" value="url" checked> URL</label>
            <label><input type="radio" name="sourceType" value="file"> Adjuntar</label>
        </div>
        <label data-source-panel="url">
            URL de la imagen
            <input type="url" name="imageUrl" placeholder="https://ejemplo.com/imagen.png">
        </label>
        <label data-source-panel="file" class="hidden">
            Archivo de imagen
            <input type="file" name="imageFile" accept="image/*">
        </label>
        <label>
            Tamaño
            <select name="imageSize">
                <option value="small">Pequeño</option>
                <option value="fit" selected>Más adecuado</option>
                <option value="original">Original</option>
                <option value="page">Ajustar al ancho de la página</option>
            </select>
        </label>
        <div class="editor-popover-actions">
            <button type="button" class="btn-reset editor-popover-cancel">Cancelar</button>
            <button type="submit" class="btn-save">Insertar imagen</button>
        </div>
    `;

    const togglePanels = () => {
        const sourceType = content.querySelector('input[name="sourceType"]:checked').value;
        content.querySelectorAll('[data-source-panel]').forEach((panel) => {
            panel.classList.toggle('hidden', panel.dataset.sourcePanel !== sourceType);
        });
    };

    content.querySelectorAll('input[name="sourceType"]').forEach((radio) => {
        radio.onchange = togglePanels;
    });

    content.querySelector('.editor-popover-cancel').onclick = () => closeEditorPopover();
    content.onsubmit = async (event) => {
        event.preventDefault();
        const formData = new FormData(content);
        const sourceType = String(formData.get('sourceType') || 'url');
        const mode = String(formData.get('imageSize') || 'fit');
        let src = '';

        if (sourceType === 'url') {
            src = String(formData.get('imageUrl') || '').trim();
        } else {
            const fileInput = content.querySelector('input[name="imageFile"]');
            const file = fileInput.files?.[0];
            if (file) {
                src = await readFileAsDataUrl(file);
            }
        }

        if (!src) {
            showToast('Selecciona una imagen o pega una URL antes de continuar.', 'error');
            return;
        }

        insertImageEmbed(quill, src, mode);
        closeEditorPopover();
    };

    openEditorPopover(anchor, content, { className: 'editor-popover-wide' });
    togglePanels();
}

function createToolbarMarkup(editorId) {
    const fontOptions = RICH_TEXT_FONTS.map((font) => `
        <option value="${font.value}">${font.label}</option>
    `).join('');
    const sizeOptions = RICH_TEXT_SIZES.map((size) => `
        <option value="${size}px">${size}</option>
    `).join('');

    return `
        <div class="editor-toolbar-shell" id="${editorId}-toolbar">
            <div class="editor-toolbar-group">
                <button type="button" class="editor-tool" data-action="bold" title="Negrita (Ctrl + B)"><i class="fa-solid fa-bold"></i></button>
                <button type="button" class="editor-tool" data-action="italic" title="Cursiva (Ctrl + I)"><i class="fa-solid fa-italic"></i></button>
                <button type="button" class="editor-tool" data-action="underline" title="Subrayado (Ctrl + U)"><i class="fa-solid fa-underline"></i></button>
                <button type="button" class="editor-tool" data-action="strike" title="Tachado"><i class="fa-solid fa-strikethrough"></i></button>
            </div>
            <div class="editor-toolbar-group">
                <select class="editor-select" data-action="font" title="Fuente">
                    <option value="">Fuente</option>
                    ${fontOptions}
                </select>
                <select class="editor-select editor-select-small" data-action="size" title="Tamaño de fuente">
                    <option value="">Tamaño</option>
                    ${sizeOptions}
                </select>
            </div>
            <div class="editor-toolbar-group">
                <button type="button" class="editor-tool editor-color-tool" data-action="color" title="Color de fuente"><i class="fa-solid fa-font"></i></button>
                <button type="button" class="editor-tool editor-color-tool" data-action="background" title="Color de fondo"><i class="fa-solid fa-highlighter"></i></button>
                <button type="button" class="editor-tool" data-action="script-super" title="Superíndice">X²</button>
                <button type="button" class="editor-tool" data-action="script-sub" title="Subíndice">X₂</button>
            </div>
            <div class="editor-toolbar-group">
                <button type="button" class="editor-tool" data-action="align-left" title="Alinear a la izquierda"><i class="fa-solid fa-align-left"></i></button>
                <button type="button" class="editor-tool" data-action="align-center" title="Alinear al centro"><i class="fa-solid fa-align-center"></i></button>
                <button type="button" class="editor-tool" data-action="align-right" title="Alinear a la derecha"><i class="fa-solid fa-align-right"></i></button>
                <button type="button" class="editor-tool" data-action="align-justify" title="Justificar"><i class="fa-solid fa-align-justify"></i></button>
                <button type="button" class="editor-tool" data-action="list-bullet" title="Viñetas"><i class="fa-solid fa-list-ul"></i></button>
                <button type="button" class="editor-tool" data-action="list-ordered" title="Numeración"><i class="fa-solid fa-list-ol"></i></button>
                <button type="button" class="editor-tool" data-action="indent-decrease" title="Reducir sangría"><i class="fa-solid fa-outdent"></i></button>
                <button type="button" class="editor-tool" data-action="indent-increase" title="Aumentar sangría"><i class="fa-solid fa-indent"></i></button>
            </div>
            <div class="editor-toolbar-break" aria-hidden="true"></div>
            <div class="editor-toolbar-group editor-toolbar-group-secondary">
                <button type="button" class="editor-tool" data-action="clean" title="Quitar formato"><i class="fa-solid fa-eraser"></i></button>
                <button type="button" class="editor-tool" data-action="blockquote" title="Insertar comilla"><i class="fa-solid fa-quote-right"></i></button>
                <button type="button" class="editor-tool" data-action="link" title="Insertar enlace"><i class="fa-solid fa-link"></i></button>
                <button type="button" class="editor-tool" data-action="table" title="Insertar tabla"><i class="fa-solid fa-table-cells"></i></button>
                <button type="button" class="editor-tool" data-action="image" title="Insertar imagen"><i class="fa-solid fa-image"></i></button>
                <button type="button" class="editor-tool" data-action="emoji" title="Insertar emoji"><i class="fa-solid fa-face-smile"></i></button>
            </div>
        </div>
    `;
}

function syncToolbarState(quill, toolbar) {
    if (!quill.hasFocus() && !toolbar.contains(document.activeElement)) {
        return;
    }

    const formats = quill.getFormat() || {};
    toolbar.querySelectorAll('.editor-tool[data-action]').forEach((button) => {
        const action = button.dataset.action;
        let active = false;
        if (action === 'bold') active = !!formats.bold;
        if (action === 'italic') active = !!formats.italic;
        if (action === 'underline') active = !!formats.underline;
        if (action === 'strike') active = !!formats.strike;
        if (action === 'blockquote') active = !!formats.blockquote;
        if (action === 'script-super') active = formats.script === 'super';
        if (action === 'script-sub') active = formats.script === 'sub';
        if (action === 'align-left') active = !formats.align;
        if (action === 'align-center') active = formats.align === 'center';
        if (action === 'align-right') active = formats.align === 'right';
        if (action === 'align-justify') active = formats.align === 'justify';
        if (action === 'list-bullet') active = formats.list === 'bullet';
        if (action === 'list-ordered') active = formats.list === 'ordered';
        button.classList.toggle('active', active);
    });

    const fontSelect = toolbar.querySelector('[data-action="font"]');
    const sizeSelect = toolbar.querySelector('[data-action="size"]');
    if (fontSelect) fontSelect.value = formats.font || '';
    if (sizeSelect) sizeSelect.value = formats.size || '';
}

function bindToolbarToEditor(quill, toolbar) {
    toolbar.querySelectorAll('.editor-tool').forEach((button) => {
        button.addEventListener('mousedown', (event) => {
            event.preventDefault();
        });
    });

    toolbar.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        const formats = quill.getFormat() || {};
        const tableContext = getTableSelectionContext(quill);

        if (action === 'color' || action === 'background') {
            createPalettePopover(quill, button, action);
            return;
        }
        if (action === 'emoji') {
            createEmojiPopover(quill, button);
            return;
        }
        if (action === 'link') {
            createLinkPopover(quill, button);
            return;
        }
        if (action === 'table') {
            createTablePopover(quill, button);
            return;
        }
        if (action === 'image') {
            createImagePopover(quill, button);
            return;
        }

        if (tableContext) {
            if (action === 'bold') formatTableSelection('bold');
            if (action === 'italic') formatTableSelection('italic');
            if (action === 'underline') formatTableSelection('underline');
            if (action === 'strike') formatTableSelection('strikeThrough');
            if (action === 'script-super') formatTableSelection('superscript');
            if (action === 'script-sub') formatTableSelection('subscript');
            if (action === 'align-left') formatTableSelection('justifyLeft');
            if (action === 'align-center') formatTableSelection('justifyCenter');
            if (action === 'align-right') formatTableSelection('justifyRight');
            if (action === 'align-justify') formatTableSelection('justifyFull');
            if (action === 'list-bullet') formatTableSelection('insertUnorderedList');
            if (action === 'list-ordered') formatTableSelection('insertOrderedList');
            if (action === 'indent-decrease') formatTableSelection('outdent');
            if (action === 'indent-increase') formatTableSelection('indent');
            if (action === 'blockquote') formatTableSelection('formatBlock', 'blockquote');
            if (action === 'clean') formatTableSelection('removeFormat');
            syncToolbarState(quill, toolbar);
            return;
        }

        withEditorRange(quill, (range) => {
            if (action === 'bold') quill.format('bold', !formats.bold, 'user');
            if (action === 'italic') quill.format('italic', !formats.italic, 'user');
            if (action === 'underline') quill.format('underline', !formats.underline, 'user');
            if (action === 'strike') quill.format('strike', !formats.strike, 'user');
            if (action === 'script-super') quill.format('script', formats.script === 'super' ? false : 'super', 'user');
            if (action === 'script-sub') quill.format('script', formats.script === 'sub' ? false : 'sub', 'user');
            if (action === 'align-left') quill.formatLine(range.index, Math.max(range.length, 1), 'align', false, 'user');
            if (action === 'align-center') quill.formatLine(range.index, Math.max(range.length, 1), 'align', 'center', 'user');
            if (action === 'align-right') quill.formatLine(range.index, Math.max(range.length, 1), 'align', 'right', 'user');
            if (action === 'align-justify') quill.formatLine(range.index, Math.max(range.length, 1), 'align', 'justify', 'user');
            if (action === 'list-bullet') quill.formatLine(range.index, Math.max(range.length, 1), 'list', formats.list === 'bullet' ? false : 'bullet', 'user');
            if (action === 'list-ordered') quill.formatLine(range.index, Math.max(range.length, 1), 'list', formats.list === 'ordered' ? false : 'ordered', 'user');
            if (action === 'indent-decrease') quill.formatLine(range.index, Math.max(range.length, 1), 'indent', '-1', 'user');
            if (action === 'indent-increase') quill.formatLine(range.index, Math.max(range.length, 1), 'indent', '+1', 'user');
            if (action === 'blockquote') quill.formatLine(range.index, Math.max(range.length, 1), 'blockquote', !formats.blockquote, 'user');
            if (action === 'clean') quill.removeFormat(range.index, Math.max(range.length, 1), 'user');
        });

        syncToolbarState(quill, toolbar);
    });

    toolbar.addEventListener('change', (event) => {
        const target = event.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        const value = target.value;
        const tableContext = getTableSelectionContext(quill);

        if (tableContext) {
            if (action === 'font' && value) {
                const font = RICH_TEXT_FONTS.find((item) => item.value === value);
                formatTableSelection('fontName', font?.label || value);
            }
            if (action === 'size' && value) {
                document.execCommand('insertHTML', false, `<span style="font-size:${escapeHtml(value)};">${window.getSelection()?.toString() || ''}</span>`);
            }
            syncToolbarState(quill, toolbar);
            return;
        }

        withEditorRange(quill, (range) => {
            if (action === 'font') quill.format('font', value || false, 'user');
            if (action === 'size') quill.format('size', value || false, 'user');
            if (action === 'align') quill.formatLine(range.index, Math.max(range.length, 1), 'align', value || false, 'user');
            if (action === 'list') quill.formatLine(range.index, Math.max(range.length, 1), 'list', value || false, 'user');
            if (action === 'indent' && value) quill.formatLine(range.index, Math.max(range.length, 1), 'indent', value, 'user');
        });

        if (action === 'indent') {
            target.value = '';
        }

        syncToolbarState(quill, toolbar);
    });

    quill.on('selection-change', (range) => {
        if (!range && document.activeElement && !toolbar.contains(document.activeElement)) {
            return;
        }
        syncToolbarState(quill, toolbar);
    });
    quill.on('text-change', () => {
        if (!quill.hasFocus()) return;
        syncToolbarState(quill, toolbar);
    });
    syncToolbarState(quill, toolbar);
}

function createRichTextEditor(selector) {
    const editorElement = document.querySelector(selector);
    const toolbarWrapper = document.createElement('div');
    toolbarWrapper.innerHTML = createToolbarMarkup(editorElement.id);
    const toolbar = toolbarWrapper.firstElementChild;
    editorElement.parentNode.insertBefore(toolbar, editorElement);

    const quillInstance = new Quill(selector, {
        theme: 'snow',
        modules: {
            toolbar: false,
            keyboard: {
                bindings: {
                    customUnderline: {
                        key: 'U',
                        shortKey: true,
                        handler(range, context) {
                            this.quill.format('underline', !context.format.underline, 'user');
                        }
                    }
                }
            }
        }
    });

    bindToolbarToEditor(quillInstance, toolbar);
    return quillInstance;
}

const quill = createRichTextEditor('#editor-container');
const resolutionQuill = createRichTextEditor('#resolution-editor');
const commentQuill = createRichTextEditor('#comment-editor');
const solutionDescriptionQuill = createRichTextEditor('#solution-description-editor');
window.solutionDescriptionQuill = solutionDescriptionQuill;
const solutionProblemQuill = solutionDescriptionQuill;
const solutionAnswerQuill = solutionDescriptionQuill;

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
    dashboardDateFrom: document.getElementById('dashboard-date-from'),
    dashboardDateTo: document.getElementById('dashboard-date-to'),
    dashboardBranch: document.getElementById('dashboard-branch-filter'),
    dashboardType: document.getElementById('dashboard-type-filter'),
    dashboardPhase: document.getElementById('dashboard-phase-filter'),
    dashboardExport: document.getElementById('dashboard-export-btn'),
    dashboardClear: document.getElementById('dashboard-clear-filters'),
    toastContainer: document.getElementById('toast-container'),
    solutions: {
        view: document.getElementById('view-solutions'),
        list: document.getElementById('solutions-list'),
        folders: document.getElementById('solutions-folders'),
        search: document.getElementById('solutions-search'),
        statusFilter: document.getElementById('solutions-status-filter'),
        newButton: document.getElementById('solutions-new-btn'),
        exportButton: document.getElementById('solutions-export-btn'),
        form: document.getElementById('solution-form'),
        formTitle: document.getElementById('solution-form-title'),
        formSubtitle: document.getElementById('solution-form-subtitle'),
        resetButton: document.getElementById('solutions-reset-btn'),
        cancelButton: document.getElementById('solution-cancel-btn'),
        deleteButton: document.getElementById('solution-delete-btn'),
        markdownLink: document.getElementById('solution-markdown-link'),
        createdAt: document.getElementById('solution-created-at'),
        updatedAt: document.getElementById('solution-updated-at')
    }
};

function apiUrl(path) {
    return `${API_BASE_URL}${path}`;
}

function parseCommaList(value) {
    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
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

function formatDuration(seconds) {
    const totalSeconds = Number(seconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--';
    if (totalSeconds < 60) return `${Math.round(totalSeconds)} s`;
    const totalMinutes = Math.round(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes} min`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours} h ${minutes} min`;
}

function getDashboardFilters() {
    return {
        date_from: elements.dashboardDateFrom?.value || '',
        date_to: elements.dashboardDateTo?.value || '',
        sucursal: elements.dashboardBranch?.value || '',
        tipo_solicitud: elements.dashboardType?.value || '',
        fase_experimento: elements.dashboardPhase?.value || ''
    };
}

function buildQueryString(params) {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            search.set(key, value);
        }
    });
    return search.toString();
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
    document.getElementById('f-fase-experimento').value = 'posttest';
    document.getElementById('f-resuelto-por').value = '';
    document.getElementById('f-decision-validada').value = '';
    document.getElementById('f-decision-chatbot').value = '';
    document.getElementById('f-fcr').value = '--';
    document.getElementById('f-numero-interacciones').value = '0';
    document.getElementById('f-razon-decision').value = '';
    document.querySelector('#pro-ticket-form .btn-save').innerText = 'Agregar solicitud';
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
        'f-asunto',
        'f-fase-experimento',
        'f-resuelto-por',
        'f-decision-validada',
        'f-razon-decision'
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

function resetSolutionForm() {
    editingSolutionId = null;
    elements.solutions.form.reset();
    solutionProblemQuill.setContents([]);
    solutionAnswerQuill.setContents([]);
    elements.solutions.formTitle.innerText = 'Nueva solución';
    elements.solutions.formSubtitle.innerText = 'Crea artículos de soporte listos para consulta humana y futura indexación.';
    elements.solutions.deleteButton.classList.add('hidden');
    elements.solutions.resetButton.classList.add('hidden');
    elements.solutions.markdownLink.innerText = 'Se generará al guardar';
    elements.solutions.markdownLink.href = '#';
    elements.solutions.markdownLink.classList.add('muted-link');
}

function fillSolutionForm(solution) {
    editingSolutionId = solution._id;
    document.getElementById('s-titulo').value = solution.titulo || '';
    document.getElementById('s-categoria').value = solution.categoria || '';
    document.getElementById('s-estado').value = solution.estado || 'Publicada';
    document.getElementById('s-resumen').value = solution.resumen || '';
    document.getElementById('s-etiquetas').value = (solution.etiquetas || []).join(', ');
    document.getElementById('s-palabras-clave').value = (solution.palabras_clave || []).join(', ');
    solutionProblemQuill.root.innerHTML = solution.problema_html || '';
    solutionAnswerQuill.root.innerHTML = solution.solucion_html || '';
    elements.solutions.formTitle.innerText = solution.titulo || 'Editar solución';
    elements.solutions.formSubtitle.innerText = `Última actualización: ${formatDate(solution.updated_at, true)}`;
    elements.solutions.deleteButton.classList.remove('hidden');
    elements.solutions.resetButton.classList.remove('hidden');

    if (solution.markdown_url) {
        elements.solutions.markdownLink.href = apiAssetUrl(solution.markdown_url);
        elements.solutions.markdownLink.innerText = solution.markdown_url.split('/').pop();
        elements.solutions.markdownLink.classList.remove('muted-link');
    } else {
        elements.solutions.markdownLink.href = '#';
        elements.solutions.markdownLink.innerText = 'Se generará al guardar';
        elements.solutions.markdownLink.classList.add('muted-link');
    }
}

function renderSolutions() {
    const term = elements.solutions.search.value.trim().toLowerCase();
    const status = elements.solutions.statusFilter.value;
    const filtered = allSolutions.filter((solution) => {
        const haystack = [
            solution.titulo,
            solution.categoria,
            solution.resumen,
            ...(solution.etiquetas || []),
            ...(solution.palabras_clave || [])
        ].join(' ').toLowerCase();
        const matchesTerm = term ? haystack.includes(term) : true;
        const matchesStatus = status ? solution.estado === status : true;
        return matchesTerm && matchesStatus;
    });

    if (!filtered.length) {
        elements.solutions.list.innerHTML = '<div class="muted-panel">Todavía no hay soluciones que coincidan con tu búsqueda.</div>';
        return;
    }

    elements.solutions.list.innerHTML = filtered.map((solution) => `
        <article class="solution-card ${solution._id === editingSolutionId ? 'active' : ''}" onclick="openSolutionEditor('${solution._id}')">
            <div class="solution-card-top">
                <span class="solution-status ${solution.estado === 'Publicada' ? 'published' : 'draft'}">${escapeHtml(solution.estado)}</span>
                <span class="solution-date">${formatDate(solution.updated_at)}</span>
            </div>
            <h3>${escapeHtml(solution.titulo)}</h3>
            <p>${escapeHtml(solution.resumen)}</p>
            <div class="solution-meta">
                <span>${escapeHtml(solution.categoria)}</span>
                <span>${escapeHtml((solution.etiquetas || []).slice(0, 3).join(' · ') || 'Sin etiquetas')}</span>
            </div>
        </article>
    `).join('');
}

async function loadSolutions() {
    try {
        const res = await fetch(apiUrl('/solutions'));
        if (!res.ok) throw new Error('No se pudieron cargar las soluciones.');
        const data = await res.json();
        allSolutions = data.items || [];
        renderSolutions();
    } catch (error) {
        console.error(error);
        showToast(error.message || 'No se pudieron cargar las soluciones.', 'error');
    }
}

async function openSolutionEditor(id) {
    try {
        const res = await fetch(apiUrl(`/solutions/${id}`));
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'No se pudo abrir la solución.');
        fillSolutionForm(data);
        renderSolutions();
    } catch (error) {
        console.error(error);
        showToast(error.message || 'No se pudo abrir la solución.', 'error');
    }
}
window.openSolutionEditor = openSolutionEditor;

const toggleView = (showForm) => {
    document.getElementById('view-mantenimiento').classList.add('hidden');
    document.getElementById('view-dashboard').classList.add('hidden');
    document.getElementById('view-solutions').classList.add('hidden');

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
    document.getElementById('view-solutions').classList.add('hidden');
    document.getElementById('view-mantenimiento').classList.remove('hidden');
    updateActiveNavLink('nav-inicio-link');
    refreshHomeSummary();
}

async function showDashboard() {
    document.getElementById('view-table').classList.add('hidden');
    document.getElementById('view-form').classList.add('hidden');
    document.getElementById('view-mantenimiento').classList.add('hidden');
    document.getElementById('view-solutions').classList.add('hidden');
    document.getElementById('view-dashboard').classList.remove('hidden');
    updateActiveNavLink('nav-dashboard-link');
    await cargarMetricas();
    initCharts();
}

async function showSolutions() {
    document.getElementById('view-table').classList.add('hidden');
    document.getElementById('view-form').classList.add('hidden');
    document.getElementById('view-dashboard').classList.add('hidden');
    document.getElementById('view-mantenimiento').classList.add('hidden');
    document.getElementById('view-solutions').classList.remove('hidden');
    updateActiveNavLink('nav-soluciones-link');
    await loadSolutions();
    if (!editingSolutionId) {
        resetSolutionForm();
    }
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
        resolucion_html: resolutionHtml,
        fase_experimento: document.getElementById('f-fase-experimento').value,
        resuelto_por: document.getElementById('f-resuelto-por').value,
        decision_validada: document.getElementById('f-decision-validada').value,
        razon_decision: document.getElementById('f-razon-decision').value
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

async function cargarTickets({ animateRows = true } = {}) {
    animateRowsOnNextRender = animateRows;

    if (ticketsLoadPromise) {
        return ticketsLoadPromise;
    }

    ticketsLoadPromise = (async () => {
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
        } finally {
            ticketsLoadPromise = null;
        }
    })();

    return ticketsLoadPromise;
}

async function cargarMetricas() {
    try {
        const query = buildQueryString(getDashboardFilters());
        const res = await fetch(apiUrl(`/tickets/metrics${query ? `?${query}` : ''}`));
        if (!res.ok) throw new Error('No se pudieron cargar las métricas del panel.');
        dashboardData = await res.json();
    } catch (error) {
        console.error(error);
        dashboardData = null;
    }
}

function exportDashboardData() {
    const query = buildQueryString(getDashboardFilters());
    window.open(apiUrl(`/tickets/export${query ? `?${query}` : ''}`), '_blank', 'noopener');
}

async function refreshDashboardWithFilters() {
    await cargarMetricas();
    initCharts();
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

    renderTable(filtrados, { animateRows: animateRowsOnNextRender });
    animateRowsOnNextRender = false;
}

function renderTable(data, { animateRows = false } = {}) {
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

    const rowsHtml = data.map((ticket) => {
        const ticketDisplayId = ticket['ID-ITIL'] || `#${String(ticket._id).slice(-5)}`;
        const fecha = formatDate(ticket.fecha_creacion);
        const prioClass = ticket.prioridad === 'Alta' ? 'prio-alta' : ticket.prioridad === 'Normal' ? 'prio-normal' : 'prio-baja';
        return `
            <tr class="${animateRows ? 'animate-in ' : ''}clickable-row" onclick="prepararEdicion('${ticket._id}')">
                <td data-label="ID">${ticketDisplayId}</td>
                <td data-label="Asunto" style="color:var(--zoho-blue); font-weight:600;">${escapeHtml(ticket.asunto)}</td>
                <td data-label="Solicitante">${escapeHtml(ticket.solicitante || '--')}</td>
                <td data-label="Estado"><span class="status-pill">${escapeHtml(ticket.estado || 'Abierto')}</span></td>
                <td data-label="Prioridad"><span class="prio-tag ${prioClass}">${escapeHtml(ticket.prioridad)}</span></td>
                <td data-label="Fecha">${fecha}</td>
                <td data-label="Acciones" class="actions-cell" onclick="event.stopPropagation()">
                    <i class="fa-solid fa-pen-to-square edit-btn" onclick="prepararEdicion('${ticket._id}')" title="Ver Detalles/Editar"></i>
                    <i class="fa-solid fa-trash delete-btn" onclick="eliminarTicket('${ticket._id}')" title="Eliminar"></i>
                </td>
            </tr>`;
    }).join('');

    body.innerHTML = rowsHtml;
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
        document.getElementById('f-fase-experimento').value = ticket.fase_experimento || '';
        document.getElementById('f-resuelto-por').value = ticket.resuelto_por || '';
        document.getElementById('f-decision-validada').value = ticket.decision_validada === true ? 'true' : ticket.decision_validada === false ? 'false' : '';
        document.getElementById('f-decision-chatbot').value = ticket.decision_chatbot || '--';
        document.getElementById('f-fcr').value = ticket.fcr === true ? 'Sí' : ticket.fcr === false ? 'No' : '--';
        document.getElementById('f-numero-interacciones').value = ticket.numero_interacciones_previas ?? ticket.numero_interacciones ?? 0;
        document.getElementById('f-razon-decision').value = ticket.razon_decision || '';
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

    const saveBtn = document.querySelector('#pro-ticket-form .btn-save');
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

function buildAvatarMillisecondSeed() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    const millisecond = String(now.getMilliseconds()).padStart(3, '0');
    return `${DEFAULT_USER}-${year}${month}${day}${hour}${minute}${second}${millisecond}`;
}

function setRandomUser() {
    const photoImg = document.getElementById('user-photo');
    const solicitanteInput = document.getElementById('f-solicitante');
    solicitanteInput.value = DEFAULT_USER;
    const millisecondSeed = buildAvatarMillisecondSeed();
    photoImg.src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(millisecondSeed)}&backgroundColor=transparent`;
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
    const summary = dashboardData.summary || {};

    document.getElementById('kpi-avg-attention').innerText = formatDuration(summary.average_resolution_seconds);
    document.getElementById('kpi-fcr').innerText = summary.fcr_rate != null ? `${summary.fcr_rate}%` : '--';
    document.getElementById('kpi-chatbot').innerText = summary.chatbot_resolution_rate != null ? `${summary.chatbot_resolution_rate}%` : '--';
    document.getElementById('kpi-escalation').innerText = summary.escalation_rate != null ? `${summary.escalation_rate}%` : '--';
    document.getElementById('kpi-classification').innerText = summary.classification_accuracy_rate != null
        ? `${summary.classification_accuracy_rate}%`
        : '--';

    const phaseSummary = dashboardData.phase_summary || {};
    const pretest = phaseSummary.pretest || {};
    const posttest = phaseSummary.posttest || {};
    document.getElementById('phase-avg-pre').innerText = formatDuration(pretest.average_resolution_seconds);
    document.getElementById('phase-avg-post').innerText = formatDuration(posttest.average_resolution_seconds);
    document.getElementById('phase-fcr-pre').innerText = pretest.fcr_rate != null ? `${pretest.fcr_rate}%` : '--';
    document.getElementById('phase-fcr-post').innerText = posttest.fcr_rate != null ? `${posttest.fcr_rate}%` : '--';
    document.getElementById('phase-esc-pre').innerText = pretest.escalation_rate != null ? `${pretest.escalation_rate}%` : '--';
    document.getElementById('phase-esc-post').innerText = posttest.escalation_rate != null ? `${posttest.escalation_rate}%` : '--';
    document.getElementById('phase-chatbot-pre').innerText = pretest.chatbot_resolution_rate != null ? `${pretest.chatbot_resolution_rate}%` : '--';
    document.getElementById('phase-chatbot-post').innerText = posttest.chatbot_resolution_rate != null ? `${posttest.chatbot_resolution_rate}%` : '--';
    document.getElementById('phase-class-pre').innerText = pretest.classification_accuracy_rate != null ? `${pretest.classification_accuracy_rate}%` : '--';
    document.getElementById('phase-class-post').innerText = posttest.classification_accuracy_rate != null ? `${posttest.classification_accuracy_rate}%` : '--';

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

async function submitSolutionForm(event) {
    event.preventDefault();
    const payload = {
        titulo: document.getElementById('s-titulo').value,
        categoria: document.getElementById('s-categoria').value,
        estado: document.getElementById('s-estado').value,
        resumen: document.getElementById('s-resumen').value,
        etiquetas: parseCommaList(document.getElementById('s-etiquetas').value),
        palabras_clave: parseCommaList(document.getElementById('s-palabras-clave').value),
        problema_html: solutionProblemQuill.root.innerHTML,
        solucion_html: solutionAnswerQuill.root.innerHTML
    };

    try {
        const url = editingSolutionId ? apiUrl(`/solutions/${editingSolutionId}`) : apiUrl('/solutions');
        const method = editingSolutionId ? 'PUT' : 'POST';
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'No se pudo guardar la solución.');
        showToast(editingSolutionId ? 'Solución actualizada.' : 'Solución creada.', 'success');
        editingSolutionId = data._id;
        await loadSolutions();
        fillSolutionForm(data);
    } catch (error) {
        console.error(error);
        showToast(error.message || 'No se pudo guardar la solución.', 'error');
    }
}

async function deleteSolution() {
    if (!editingSolutionId) return;
    const confirmed = await showConfirmToast('¿Deseas eliminar esta solución?', {
        type: 'error',
        confirmLabel: 'Eliminar',
        cancelLabel: 'Cancelar'
    });
    if (!confirmed) return;

    try {
        const res = await fetch(apiUrl(`/solutions/${editingSolutionId}`), { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'No se pudo eliminar la solución.');
        resetSolutionForm();
        await loadSolutions();
        showToast(data.msg || 'Solución eliminada.', 'success');
    } catch (error) {
        console.error(error);
        showToast(error.message || 'No se pudo eliminar la solución.', 'error');
    }
}

async function exportSolutionsToMarkdown() {
    try {
        const res = await fetch(apiUrl('/solutions/export'), { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'No se pudieron exportar las soluciones.');
        await loadSolutions();
        showToast(`${data.count || 0} solución(es) exportadas a Markdown.`, 'success');
    } catch (error) {
        console.error(error);
        showToast(error.message || 'No se pudieron exportar las soluciones.', 'error');
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
    document.getElementById('nav-soluciones-link').onclick = async (event) => {
        event.preventDefault();
        await showSolutions();
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
    [elements.dashboardDateFrom, elements.dashboardDateTo, elements.dashboardBranch, elements.dashboardType, elements.dashboardPhase]
        .filter(Boolean)
        .forEach((input) => input.addEventListener('change', refreshDashboardWithFilters));
    elements.dashboardExport?.addEventListener('click', exportDashboardData);
    elements.dashboardClear?.addEventListener('click', async () => {
        elements.dashboardDateFrom.value = '';
        elements.dashboardDateTo.value = '';
        elements.dashboardBranch.value = '';
        elements.dashboardType.value = '';
        elements.dashboardPhase.value = '';
        await refreshDashboardWithFilters();
    });
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
    document.querySelectorAll('#pro-ticket-form input, #pro-ticket-form select, #pro-ticket-form textarea').forEach((input) => {
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

    document.getElementById('user-photo').onclick = () => {
        setRandomUser();
    };

    elements.solutions.search.oninput = renderSolutions;
    elements.solutions.statusFilter.onchange = renderSolutions;
    elements.solutions.newButton.onclick = () => {
        resetSolutionForm();
        renderSolutions();
    };
    elements.solutions.resetButton.onclick = () => {
        resetSolutionForm();
        renderSolutions();
    };
    elements.solutions.cancelButton.onclick = () => {
        resetSolutionForm();
        renderSolutions();
    };
    elements.solutions.deleteButton.onclick = deleteSolution;
    elements.solutions.exportButton.onclick = exportSolutionsToMarkdown;
    elements.solutions.form.onsubmit = submitSolutionForm;
}

async function initApp() {
    bindEvents();
    await cargarCategorias();
    resetFormState();
    resetSolutionForm();
    setRandomUser();
    await cargarTickets();
    showInicio();
}

initApp();

