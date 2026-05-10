// --- ELEMENTI DOM ---
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const statusIndicators = document.querySelectorAll('.status-indicator');

const btnScatta = document.getElementById('btn-scatta');
const btnUploadSend = document.getElementById('btn-upload-send');
const universalInput = document.getElementById('universal-input');
const previewImg = document.getElementById('preview-img');
const fileNameDisplay = document.getElementById('file-name-display');
const textInput = document.getElementById('text-input');
const btnSendText = document.getElementById('btn-send-text');
const incomingContainer = document.getElementById('incoming-history-container');
const toast = document.getElementById('new-item-toast');

const MAX_TEXT_CHARS = 20000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 14 * 1024 * 1024;
const SEND_ACK_TIMEOUT_MS = 8000;
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;
const BLOCKED_FILE_DATA_URL = /^data:(?:text\/html|image\/svg\+xml|application\/xhtml\+xml)\b/i;

let conn;
let isAuthenticated = false;
let cameraStream = null;
let toastTimeout;
const pendingSends = new Map();

function updateStatus(text, className = null) {
    statusIndicators.forEach(el => {
        el.innerText = text;
        el.className = 'status-indicator';
        if (className) el.classList.add(className);
    });
}

function createMessageId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sanitizeFileName(name) {
    if (typeof name !== 'string') return 'StudyTunnel_File';
    const clean = name
        .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return clean || 'StudyTunnel_File';
}

function formatBytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isSafeDataUrl(dataUrl, imageOnly = false) {
    if (typeof dataUrl !== 'string') return false;
    if (dataUrl.length > MAX_DATA_URL_CHARS) return false;
    if (imageOnly) return SAFE_IMAGE_DATA_URL.test(dataUrl);
    if (!/^data:[^,]*;base64,/i.test(dataUrl)) return false;
    return !BLOCKED_FILE_DATA_URL.test(dataUrl);
}

function normalizePayload(item) {
    if (typeof item === 'string') {
        item = { type: 'image', data: item };
    }

    if (!item || typeof item !== 'object') {
        return { ok: false, error: "Payload non valido." };
    }

    const id = typeof item.id === 'string' && item.id.length <= 100 ? item.id : createMessageId();

    if (item.type === 'text') {
        if (typeof item.data !== 'string') return { ok: false, error: "Testo non valido." };
        if (item.data.length > MAX_TEXT_CHARS) return { ok: false, error: "Testo troppo lungo." };
        return { ok: true, payload: { type: 'text', data: item.data, id } };
    }

    if (item.type === 'image') {
        if (!isSafeDataUrl(item.data, true)) return { ok: false, error: "Immagine non valida o troppo grande." };
        return { ok: true, payload: { type: 'image', data: item.data, id } };
    }

    if (item.type === 'file') {
        if (!isSafeDataUrl(item.data, false)) return { ok: false, error: "File non valido, attivo o troppo grande." };
        return { ok: true, payload: { type: 'file', data: item.data, name: sanitizeFileName(item.name), id } };
    }

    return { ok: false, error: "Tipo di payload non supportato." };
}

function createOutgoingPayload(rawPayload) {
    const normalized = normalizePayload({ ...rawPayload, id: createMessageId() });
    return normalized;
}

function dataUrlToBlob(dataUrl) {
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex === -1) throw new Error("Data URL non valido.");
    const meta = dataUrl.slice(0, commaIndex);
    const base64 = dataUrl.slice(commaIndex + 1);
    const mime = /^data:([^;,]+)/i.exec(meta)?.[1] || 'application/octet-stream';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

function getSessionParams() {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const queryParams = new URLSearchParams(window.location.search);
    const id = hashParams.get('id') || queryParams.get('id');
    const token = hashParams.get('token') || queryParams.get('token');
    return {
        id,
        token,
        fromQuery: Boolean(queryParams.get('id') || queryParams.get('token'))
    };
}

function moveQuerySecretToHash(id, token) {
    if (!id || !token || !window.history?.replaceState) return;
    const safeHash = `#id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
    window.history.replaceState(null, document.title, `${window.location.pathname}${safeHash}`);
}

const session = getSessionParams();
const targetPeerId = session.id;
const authToken = session.token;

if (session.fromQuery) {
    moveQuerySecretToHash(targetPeerId, authToken);
}

// --- 1. CONNESSIONE AL PC ---
if (!targetPeerId || !authToken) {
    updateStatus("❌ Nessun ID. Scansiona il QR Code!", "error");
} else {
    const peer = new Peer();

    peer.on('open', () => {
        updateStatus("Cerco il computer...");
        conn = peer.connect(targetPeerId);

        conn.on('open', () => {
            updateStatus("Autenticazione in corso...");
            conn.send({ type: 'auth', token: authToken });
        });

        conn.on('data', (data) => {
            if (data && data.type === 'auth_success') {
                isAuthenticated = true;
                updateStatus("✅ Connesso Sicuro!", "connected");
                document.getElementById('received-section').style.display = 'block';
                return;
            }

            if (data && data.type === 'auth_failed') {
                isAuthenticated = false;
                updateStatus("❌ QR scaduto. Generane uno nuovo.", "error");
                return;
            }

            if (data && data.type === 'delivery_ack') {
                completePendingSend(data.id);
                return;
            }

            if (data && data.type === 'delivery_error') {
                failPendingSend(data.id, data.error || "Invio non confermato.");
                return;
            }

            const normalized = normalizePayload(data);
            if (!normalized.ok) {
                if (conn?.open) conn.send({ type: 'delivery_error', id: data?.id, error: normalized.error });
                updateStatus(normalized.error, "error");
                return;
            }

            handleIncomingData(normalized.payload);
            if (conn?.open) conn.send({ type: 'delivery_ack', id: normalized.payload.id });
        });

        conn.on('close', () => {
            isAuthenticated = false;
            rejectAllPendingSends("Connessione chiusa.");
            updateStatus("Connessione chiusa. Genera un nuovo QR.", "error");
            stopCamera();
        });

        conn.on('error', () => {
            isAuthenticated = false;
            rejectAllPendingSends("Errore connessione.");
            updateStatus("❌ Errore connessione.", "error");
            stopCamera();
        });
    });

    peer.on('disconnected', () => {
        isAuthenticated = false;
        rejectAllPendingSends("Connessione persa.");
        updateStatus("Connessione persa.", "error");
    });

    peer.on('error', () => {
        isAuthenticated = false;
        rejectAllPendingSends("Computer non raggiungibile.");
        updateStatus("❌ Computer non raggiungibile.", "error");
    });
}

// --- 2. GESTIONE FOTOCAMERA ---
async function startCamera() {
    if (cameraStream || !video) return;

    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Fotocamera non supportata.");
        }

        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = cameraStream;
    } catch (err) {
        updateStatus("Nessun accesso alla fotocamera.", "error");
    }
}

function stopCamera() {
    if (!cameraStream) return;
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    if (video) video.srcObject = null;
}

window.startStudyTunnelCamera = startCamera;
window.stopStudyTunnelCamera = stopCamera;

if (btnScatta) {
    btnScatta.addEventListener('click', async () => {
        if (!checkConnection()) return;
        if (!video.videoWidth || !video.videoHeight) {
            alert("La fotocamera non è ancora pronta.");
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        await sendPayload({ type: 'image', data: canvas.toDataURL('image/jpeg', 0.8) }, btnScatta);
    });
}

// --- 3. GESTIONE UPLOAD FILE E IMMAGINI ---
function resetUploadSelection() {
    window.fileToSend = null;
    if (universalInput) universalInput.value = '';
    if (previewImg) {
        previewImg.removeAttribute('src');
        previewImg.style.display = 'none';
    }
    if (fileNameDisplay) fileNameDisplay.innerText = 'Cosa vuoi caricare?';
    if (btnUploadSend) btnUploadSend.disabled = true;
}

function handleFileSelection(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > MAX_FILE_BYTES) {
        alert(`File troppo grande. Limite: ${formatBytes(MAX_FILE_BYTES)}.`);
        resetUploadSelection();
        return;
    }

    fileNameDisplay.innerText = file.name;
    const reader = new FileReader();
    reader.onload = function(event) {
        const fileData = event.target.result;

        if (BLOCKED_FILE_DATA_URL.test(fileData)) {
            alert("Questo tipo di file attivo non è supportato per sicurezza.");
            resetUploadSelection();
            return;
        }

        if (file.type.startsWith('image/') && SAFE_IMAGE_DATA_URL.test(fileData)) {
            previewImg.src = fileData;
            previewImg.style.display = 'block';
            window.fileToSend = { isImage: true, data: fileData, name: sanitizeFileName(file.name) };
        } else {
            previewImg.style.display = 'none';
            window.fileToSend = { isImage: false, data: fileData, name: sanitizeFileName(file.name) };
        }

        btnUploadSend.disabled = false;
    };
    reader.onerror = () => {
        alert("Non riesco a leggere il file.");
        resetUploadSelection();
    };
    reader.readAsDataURL(file);
}

if (universalInput) universalInput.addEventListener('change', handleFileSelection);

if (btnUploadSend) {
    btnUploadSend.addEventListener('click', async () => {
        if (!checkConnection() || !window.fileToSend) return;

        if (window.fileToSend.isImage) {
            const result = await sendPayload({ type: 'image', data: window.fileToSend.data }, btnUploadSend);
            if (result.ok) resetUploadSelection();
        } else {
            const result = await sendPayload({ type: 'file', data: window.fileToSend.data, name: window.fileToSend.name }, btnUploadSend);
            if (result.ok) resetUploadSelection();
        }
    });
}

// --- 4. GESTIONE TESTO PURO ---
if (btnSendText) {
    btnSendText.addEventListener('click', async () => {
        if (!checkConnection()) return;
        const testo = textInput.value.trim();
        if (testo === '') {
            alert("Inserisci del testo!");
            return;
        }

        const result = await sendPayload({ type: 'text', data: testo }, btnSendText);
        if (result.ok) textInput.value = '';
    });
}

// --- FUNZIONI DI SUPPORTO ---
function checkConnection() {
    if (!conn || !conn.open || !isAuthenticated) {
        alert("Aspetta di essere connesso al PC!");
        return false;
    }
    return true;
}

function sendPayload(rawPayload, btnElement) {
    if (!checkConnection()) return Promise.resolve({ ok: false, error: "Non connesso." });

    const normalized = createOutgoingPayload(rawPayload);
    if (!normalized.ok) {
        alert(normalized.error);
        return Promise.resolve({ ok: false, error: normalized.error });
    }

    const payload = normalized.payload;
    const oldText = btnElement.innerText;
    btnElement.disabled = true;
    btnElement.innerText = "Invio...";

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            pendingSends.delete(payload.id);
            btnElement.disabled = false;
            btnElement.innerText = oldText;
            alert("Nessuna conferma dal PC.");
            resolve({ ok: false, error: "Nessuna conferma dal PC." });
        }, SEND_ACK_TIMEOUT_MS);

        pendingSends.set(payload.id, { btnElement, oldText, timeout, resolve });

        try {
            conn.send(payload);
        } catch (err) {
            failPendingSend(payload.id, "Invio fallito.");
        }
    });
}

function completePendingSend(id) {
    const pending = pendingSends.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingSends.delete(id);

    pending.btnElement.disabled = false;
    pending.btnElement.innerText = "✓ Inviato!";
    pending.btnElement.classList.add('sent');

    setTimeout(() => {
        pending.btnElement.innerText = pending.oldText;
        pending.btnElement.classList.remove('sent');
    }, 2000);

    pending.resolve({ ok: true });
}

function failPendingSend(id, error) {
    const pending = pendingSends.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingSends.delete(id);
    pending.btnElement.disabled = false;
    pending.btnElement.innerText = pending.oldText;
    alert(error || "Invio non riuscito.");
    pending.resolve({ ok: false, error });
}

function rejectAllPendingSends(error) {
    for (const id of Array.from(pendingSends.keys())) {
        failPendingSend(id, error);
    }
}

// --- 5. RICEZIONE DAL PC ---
function handleIncomingData(item) {
    if (!incomingContainer) return;

    const itemDiv = document.createElement('div');
    itemDiv.className = 'incoming-item';

    if (item.type === 'text') {
        const textEl = document.createElement('div');
        textEl.className = 'incoming-text';
        textEl.innerText = item.data;
        itemDiv.appendChild(textEl);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'incoming-btn';
        copyBtn.innerText = 'Copia Testo';
        copyBtn.onclick = () => copyText(item.data, copyBtn);
        itemDiv.appendChild(copyBtn);
    } else if (item.type === 'image') {
        const imgEl = document.createElement('img');
        imgEl.className = 'incoming-img';
        imgEl.src = item.data;
        itemDiv.appendChild(imgEl);

        const downBtn = document.createElement('button');
        downBtn.className = 'incoming-btn';
        downBtn.innerText = 'Apri / Scarica Immagine';
        downBtn.onclick = () => downloadFile(item.data, 'immagine_ricevuta.jpg');
        itemDiv.appendChild(downBtn);
    } else if (item.type === 'file') {
        const fileEl = document.createElement('div');
        fileEl.className = 'incoming-file';

        const iconSpan = document.createElement('span');
        iconSpan.style.fontSize = '24px';
        iconSpan.innerText = '📄';
        fileEl.appendChild(iconSpan);
        fileEl.appendChild(document.createTextNode(item.name || 'Documento'));
        itemDiv.appendChild(fileEl);

        const downBtn = document.createElement('button');
        downBtn.className = 'incoming-btn';
        downBtn.innerText = 'Scarica File';
        downBtn.onclick = () => downloadFile(item.data, item.name);
        itemDiv.appendChild(downBtn);
    } else {
        return;
    }

    incomingContainer.insertBefore(itemDiv, incomingContainer.firstChild);

    const isHome = !document.getElementById('home-screen').classList.contains('hidden');
    if (!isHome) {
        showNewItemToast();
    }
}

// Gestione Toast Notifica
function showNewItemToast() {
    if (!toast) return;
    toast.style.display = 'block';
    void toast.offsetWidth;
    toast.style.opacity = '1';

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        hideToast();
    }, 4000);
}

function hideToast() {
    if (!toast) return;
    toast.style.opacity = '0';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 300);
}

if (toast) {
    toast.addEventListener('click', () => {
        hideToast();
        if (typeof goHome === 'function') {
            goHome();
        }
    });
}

function copyText(text, btnElement) {
    navigator.clipboard.writeText(text).then(() => {
        const oldText = btnElement.innerText;
        btnElement.innerText = "✓ Copiato!";
        btnElement.style.color = "#2e7d32";
        setTimeout(() => {
            btnElement.innerText = oldText;
            btnElement.style.color = "";
        }, 1500);
    }).catch(() => alert("Copia non riuscita."));
}

function downloadFile(dataUrl, fileName) {
    if (!isSafeDataUrl(dataUrl, false) && !isSafeDataUrl(dataUrl, true)) {
        alert("File non valido.");
        return;
    }

    const blobUrl = URL.createObjectURL(dataUrlToBlob(dataUrl));
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = sanitizeFileName(fileName || "StudyTunnel_File");
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
    }, 100);
}
