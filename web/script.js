const chatBox = document.getElementById("chat-box");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const statusEl = document.getElementById("status");

// Generar o recuperar un ID de sesión persistente
let sessionId = localStorage.getItem("chat_session_id");
if (!sessionId) {
  sessionId = "sess-" + Math.random().toString(36).substring(2, 11);
  localStorage.setItem("chat_session_id", sessionId);
}

function addMessage(text, sender, extraClass = "") {
  const msg = document.createElement("div");
  msg.classList.add("message", sender);
  if (extraClass) msg.classList.add(extraClass);
  msg.innerText = text;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
  return msg;
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  addMessage(text, "user");
  input.value = "";

  const typingMsg = addMessage("Escribiendo...", "bot", "typing");
  setStatus("Escribiendo...");

  try {
    // URL de Testing (n8n requiere que el flujo esté abierto y en modo ejecución manual)
    // const res = await fetch("http://localhost:5678/webhook-test/chatbot", {
    // URL de Producción (n8n requiere que el flujo esté guardado y activado/Active)
    const res = await fetch("http://localhost:5678/webhook/chatbot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensaje: text, usuario: "web-user", sessionId: sessionId })
    });

    const data = await res.json();

    typingMsg.remove();
    addMessage(data.text || data.respuesta || "Sin respuesta", "bot");
    setStatus("En línea");

  } catch (err) {
    typingMsg.remove();
    addMessage("Error conectando con el servidor.", "bot");
    setStatus("Desconectado");
  }
}

function setStatus(s){ if(statusEl) statusEl.textContent = s; }

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

sendBtn.addEventListener("click", sendMessage);

input.focus();
