const chatBox = document.getElementById("chat-box");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const expandBtn = document.getElementById("expandBtn");
const statusEl = document.getElementById("status");
const phoneFrame = document.querySelector(".phone-frame");
const phoneNotch = document.querySelector(".phone-notch");
const PUBLIC_BASE_URL = "https://caritive-corrosively-natalia.ngrok-free.dev";
const API_BASE_URL = `${PUBLIC_BASE_URL}/api`;

let sessionId = localStorage.getItem("chat_session_id");
if (!sessionId) {
  sessionId = `sess-${Math.random().toString(36).slice(2, 11)}`;
  localStorage.setItem("chat_session_id", sessionId);
}

let interactionCount = Number(localStorage.getItem("chat_interaction_count") || "0");
let secretTapCount = 0;
let secretTapTimer = null;
let isExpanded = localStorage.getItem("chat_expanded") === "true";

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function autoResizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function syncExpandButton() {
  if (!expandBtn) return;
  expandBtn.textContent = isExpanded ? "⤡" : "⤢";
  expandBtn.title = isExpanded ? "Reducir chat" : "Agrandar chat";
  expandBtn.setAttribute("aria-label", isExpanded ? "Reducir chat" : "Agrandar chat");
}

function applyExpandedState(animate = false) {
  if (!phoneFrame) return;
  if (!animate) {
    phoneFrame.style.transition = "none";
  }
  phoneFrame.classList.toggle("expanded", isExpanded);
  syncExpandButton();
  if (!animate) {
    window.setTimeout(() => {
      phoneFrame.style.transition = "";
    }, 20);
  }
}

function toggleExpandedState() {
  isExpanded = !isExpanded;
  localStorage.setItem("chat_expanded", String(isExpanded));
  applyExpandedState(true);
  window.setTimeout(() => {
    scrollToBottom();
    input.focus();
  }, 360);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function applyInlineFormatting(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMarkdownText(text) {
  const lines = text.split("\n");
  const html = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }

    if (line.startsWith("### ")) {
      closeList();
      html.push(`<h3>${applyInlineFormatting(line.slice(4))}</h3>`);
      continue;
    }

    const orderedMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${applyInlineFormatting(orderedMatch[2])}</li>`);
      continue;
    }

    const unorderedMatch = line.match(/^[-*]\s+(.+)$/);
    if (unorderedMatch) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${applyInlineFormatting(unorderedMatch[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${applyInlineFormatting(line)}</p>`);
  }

  closeList();
  return html.join("");
}

function renderMessageHtml(text) {
  const source = String(text || "").trim() || "Sin contenido";
  const parts = source.split(/```/);

  return parts.map((part, index) => {
    const escaped = escapeHtml(part);
    if (index % 2 === 1) {
      return `<pre><code>${escaped}</code></pre>`;
    }
    return renderMarkdownText(escaped);
  }).join("");
}

function scrollToBottom() {
  chatBox.scrollTop = chatBox.scrollHeight;
}

function closeAllMenus() {
  document.querySelectorAll(".message-menu.open").forEach((menu) => menu.classList.remove("open"));
}

function selectMessageText(messageBody) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(messageBody);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyMessageText(text) {
  await navigator.clipboard.writeText(text);
}

async function shareMessageText(text) {
  if (navigator.share) {
    await navigator.share({ text });
    return;
  }
  await copyMessageText(text);
}

function buildMenuItem(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-menu-item";
  button.textContent = label;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await onClick();
    closeAllMenus();
  });
  return button;
}

function buildMenu(body, content, message) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-menu";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "message-menu-toggle";
  toggle.setAttribute("aria-label", "Opciones del mensaje");
  toggle.textContent = "⋮";
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = wrapper.classList.contains("open");
    closeAllMenus();
    if (!isOpen) wrapper.classList.add("open");
  });

  const panel = document.createElement("div");
  panel.className = "message-menu-panel";

  panel.appendChild(buildMenuItem("Copiar", async () => {
    try {
      await copyMessageText(content);
      setStatus("Mensaje copiado");
      window.setTimeout(() => setStatus("En línea"), 1400);
    } catch {
      setStatus("No se pudo copiar");
      window.setTimeout(() => setStatus("En línea"), 1600);
    }
  }));

  panel.appendChild(buildMenuItem("Seleccionar", async () => {
    selectMessageText(body);
    setStatus("Texto seleccionado");
    window.setTimeout(() => setStatus("En línea"), 1400);
  }));

  panel.appendChild(buildMenuItem("Eliminar", async () => {
    await removeMessageWithEffect(message);
    setStatus("Mensaje eliminado");
    window.setTimeout(() => setStatus("En línea"), 1400);
  }));

  panel.appendChild(buildMenuItem("Compartir", async () => {
    try {
      await shareMessageText(content);
      setStatus(navigator.share ? "Mensaje compartido" : "Mensaje copiado");
      window.setTimeout(() => setStatus("En línea"), 1600);
    } catch {
      setStatus("No se pudo compartir");
      window.setTimeout(() => setStatus("En línea"), 1600);
    }
  }));

  wrapper.appendChild(toggle);
  wrapper.appendChild(panel);
  return wrapper;
}

function removeMessageWithEffect(message) {
  return new Promise((resolve) => {
    if (!message || message.classList.contains("deleting")) {
      resolve();
      return;
    }

    const finish = () => {
      message.remove();
      resolve();
    };

    message.addEventListener("animationend", finish, { once: true });
    message.classList.add("deleting");
  });
}

function addMessage(text, sender, extraClass = "") {
  const content = String(text || "").trim() || "Sin contenido";
  const message = document.createElement("article");
  message.className = `message ${sender}`;
  if (extraClass) message.classList.add(extraClass);

  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = renderMessageHtml(content);

  const row = document.createElement("div");
  row.className = "message-row";
  const menu = buildMenu(body, content, message);

  if (sender === "user") {
    row.appendChild(menu);
    row.appendChild(body);
  } else {
    row.appendChild(body);
    row.appendChild(menu);
  }

  message.appendChild(row);

  chatBox.appendChild(message);
  scrollToBottom();
  return message;
}

function triggerEasterEgg() {
  const emojiFrames = [
    "🌙 ✨ 🤖 ☕ 🛠️",
    "✨ 🤖 ☕ 🛠️ 🌙",
    "🤖 ☕ 🛠️ 🌙 ✨",
    "☕ 🛠️ 🌙 ✨ 🤖",
    "🛠️ 🌙 ✨ 🤖 ☕",
  ];
  const secretMessage = addMessage(emojiFrames[0], "bot", "easter-egg");
  const secretBody = secretMessage?.querySelector(".message-body");
  setStatus("Modo secreto");
  phoneNotch?.classList.add("secret-active");

  emojiFrames.slice(1).forEach((frame, index) => {
    window.setTimeout(() => {
      if (secretBody) secretBody.textContent = frame;
    }, (index + 1) * 700);
  });

  window.setTimeout(() => {
    removeMessageWithEffect(secretMessage);
  }, 3500);

  window.setTimeout(() => {
    setStatus("En línea");
    phoneNotch?.classList.remove("secret-active");
  }, 3500);
}

function registerSecretTap() {
  secretTapCount += 1;
  window.clearTimeout(secretTapTimer);

  if (secretTapCount >= 5) {
    secretTapCount = 0;
    triggerEasterEgg();
    return;
  }

  secretTapTimer = window.setTimeout(() => {
    secretTapCount = 0;
  }, 1800);
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;
  const startedAt = new Date();
  interactionCount += 1;
  localStorage.setItem("chat_interaction_count", String(interactionCount));

  addMessage(text, "user");
  input.value = "";
  autoResizeInput();
  input.focus();

  const typingMsg = addMessage("Escribiendo...", "bot", "typing");
  setStatus("Escribiendo...");

  try {
    const res = await fetch(`${PUBLIC_BASE_URL}/n8n/webhook/chatbot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensaje: text, usuario: "web-user", sessionId })
    });

    const data = await res.json();
    const responseText = data.text || data.respuesta || "Sin respuesta";
    const ticketMatch = String(responseText).match(/\b(?:INC|RQ)-\d{7}\b/i);
    const explicitDecision = typeof data.decision_chatbot === "string" ? data.decision_chatbot.toLowerCase() : "";
    const wasEscalated = explicitDecision ? explicitDecision === "escalar" : Boolean(ticketMatch);
    typingMsg.remove();
    addMessage(responseText, "bot");
    fetch(`${API_BASE_URL}/chat/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        usuario: "web-user",
        mensaje_usuario: text,
        respuesta_chatbot: responseText,
        tiempo_inicio_atencion: startedAt.toISOString(),
        tiempo_respuesta_chatbot: Number(((Date.now() - startedAt.getTime()) / 1000).toFixed(2)),
        numero_interacciones: interactionCount,
        decision_chatbot: explicitDecision || (wasEscalated ? "escalar" : "resolver"),
        fue_resuelto_en_chat: typeof data.fue_resuelto_en_chat === "boolean" ? data.fue_resuelto_en_chat : !wasEscalated,
        fue_escalado: typeof data.fue_escalado === "boolean" ? data.fue_escalado : wasEscalated,
        razon_decision: data.razon_decision || (wasEscalated
          ? "El flujo de chat derivó el caso a ticket."
          : "El chatbot respondió sin necesidad de escalamiento."),
        fase_experimento: data.fase_experimento || "posttest",
        usa_contexto_rag: typeof data.usa_contexto_rag === "boolean" ? data.usa_contexto_rag : false,
        fuente_respuesta: data.fuente_respuesta || "generativa",
        categoria_sugerida_ia: data.categoria_sugerida_ia || "",
        prioridad_sugerida_ia: data.prioridad_sugerida_ia || "",
        ticket_id: data.ticket_id || ""
      })
    }).catch(() => null);
    setStatus("En línea");
  } catch (err) {
    typingMsg.remove();
    addMessage("Error conectando con el servidor.", "bot");
    setStatus("Desconectado");
  }
}

document.addEventListener("click", () => closeAllMenus());

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

input.addEventListener("input", autoResizeInput);

sendBtn.addEventListener("click", sendMessage);
expandBtn?.addEventListener("click", toggleExpandedState);
phoneNotch?.addEventListener("click", registerSecretTap);

applyExpandedState(false);
input.focus();
autoResizeInput();
