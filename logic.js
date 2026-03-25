// --- ELEMENTI DOM ---
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const statusIndicators = document.querySelectorAll('.status-indicator');

function updateStatus(text, className = null) {
    statusIndicators.forEach(el => {
        el.innerText = text;
        el.className = 'status-indicator'; // Reset classi
        if (className) el.classList.add(className);
    });
}

// Bottoni e Input
const btnScatta = document.getElementById('btn-scatta');
const btnUploadSend = document.getElementById('btn-upload-send');
const universalInput = document.getElementById('universal-input');     
const previewImg = document.getElementById('preview-img');
const fileNameDisplay = document.getElementById('file-name-display');
const textInput = document.getElementById('text-input');
const btnSendText = document.getElementById('btn-send-text');

let conn; 

// --- 1. CONNESSIONE AL PC ---
const urlParams = new URLSearchParams(window.location.search);
const targetPeerId = urlParams.get('id');
const authToken = urlParams.get('token');

if (!targetPeerId || !authToken) {
    updateStatus("❌ Nessun ID. Scansiona il QR Code!", "error");
} else {
    // TORNATO ALLA NORMALITA'
    const peer = new Peer();
    
    peer.on('open', (id) => {
        updateStatus("Cerco il computer...");
        conn = peer.connect(targetPeerId);

        conn.on('open', () => {
            updateStatus("Autenticazione in corso...");
            // Esegue handshake di sicurezza
            conn.send({ type: 'auth', token: authToken });
        });
        
        conn.on('data', (data) => {
            if (data && data.type === 'auth_success') {
                updateStatus("✅ Connesso Sicuro!", "connected");
                document.getElementById('received-section').style.display = 'block';
                return;
            }
            handleIncomingData(data);
        });

        conn.on('error', (err) => {
            updateStatus("❌ Errore connessione.", "error");
        });
    });
}

// --- 2. GESTIONE FOTOCAMERA ---
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
    } catch (err) {
        statusText.innerText = "Nessun accesso alla fotocamera.";
    }
}
startCamera(); 

if (btnScatta) {
    btnScatta.addEventListener('click', () => {
        if (!checkConnection()) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        conn.send({ type: 'image', data: canvas.toDataURL('image/jpeg', 0.8) });
        feedbackBottone(btnScatta);
    });
}

// --- 3. GESTIONE UPLOAD FILE E IMMAGINI ---
function handleFileSelection(e) {
    const file = e.target.files[0];
    if (!file) return;
    fileNameDisplay.innerText = file.name; 
    const reader = new FileReader();
    reader.onload = function(event) {
        const fileData = event.target.result;
        if (file.type.startsWith('image/')) {
            previewImg.src = fileData;
            previewImg.style.display = 'block';
            window.fileToSend = { isImage: true, data: fileData, name: file.name };
        } else {
            previewImg.style.display = 'none';
            window.fileToSend = { isImage: false, data: fileData, name: file.name };
        }
        btnUploadSend.disabled = false;
    };
    reader.readAsDataURL(file); 
}

if (universalInput) universalInput.addEventListener('change', handleFileSelection);

if (btnUploadSend) {
    btnUploadSend.addEventListener('click', () => {
        if (!checkConnection() || !window.fileToSend) return;
        if (window.fileToSend.isImage) {
            const img = new Image();
            img.src = window.fileToSend.data;
            img.onload = () => {
                const maxWidth = 1200;
                const scale = maxWidth / img.width;
                if (scale < 1) { canvas.width = maxWidth; canvas.height = img.height * scale; } 
                else { canvas.width = img.width; canvas.height = img.height; }
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                conn.send({ type: 'image', data: canvas.toDataURL('image/jpeg', 0.8) });
                feedbackBottone(btnUploadSend);
            };
        } else {
            conn.send({ type: 'file', data: window.fileToSend.data, name: window.fileToSend.name });
            feedbackBottone(btnUploadSend);
        }
    });
}

// --- 4. GESTIONE TESTO PURO ---
if (btnSendText) {
    btnSendText.addEventListener('click', () => {
        if (!checkConnection()) return;
        const testo = textInput.value.trim();
        if (testo === '') { alert("Inserisci del testo!"); return; }
        conn.send({ type: 'text', data: testo });
        feedbackBottone(btnSendText);
    });
}

// --- FUNZIONI DI SUPPORTO ---
function checkConnection() {
    if (!conn || !conn.open) {
        alert("Aspetta di essere connesso al PC!");
        return false;
    }
    return true;
}

function feedbackBottone(btnElement) {
    const oldText = btnElement.innerText;
    btnElement.innerText = "✓ Inviato!";
    btnElement.classList.add('sent');
    setTimeout(() => {
        btnElement.innerText = oldText;
        btnElement.classList.remove('sent');
    }, 2000);
}

// --- 5. RICEZIONE DAL PC ---
const incomingContainer = document.getElementById('incoming-history-container');

function handleIncomingData(item) {
    // Gestione retrocompatibilità se arriva solo una stringa base64 di un'immagine
    if (typeof item === 'string') {
        item = { type: 'image', data: item };
    }

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

        // Su mobile il download programmatico spesso apre l'immagine in una nuova tab
        const downBtn = document.createElement('button');
        downBtn.className = 'incoming-btn';
        downBtn.innerText = 'Apri / Scarica Immagine';
        downBtn.onclick = () => downloadFile(item.data, 'immagine_ricevuta.jpg');
        itemDiv.appendChild(downBtn);

    } else if (item.type === 'file') {
        const fileEl = document.createElement('div');
        fileEl.className = 'incoming-file';
        fileEl.innerHTML = `<span style="font-size:24px">📄</span> ${item.name || 'Documento'}`;
        itemDiv.appendChild(fileEl);

        const downBtn = document.createElement('button');
        downBtn.className = 'incoming-btn';
        downBtn.innerText = 'Scarica File';
        downBtn.onclick = () => downloadFile(item.data, item.name);
        itemDiv.appendChild(downBtn);
    }

    // Aggiungi in cima
    incomingContainer.insertBefore(itemDiv, incomingContainer.firstChild);

    // Controlla se siamo nella home
    const isHome = !document.getElementById('home-screen').classList.contains('hidden');
    if (!isHome) {
        showNewItemToast();
    }
}

// Gestione Toast Notifica
const toast = document.getElementById('new-item-toast');
let toastTimeout;

function showNewItemToast() {
    toast.style.display = 'block';
    // Forza il reflow per l'animazione css
    void toast.offsetWidth;
    toast.style.opacity = '1';

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        hideToast();
    }, 4000); // Nascondi dopo 4 secondi
}

function hideToast() {
    toast.style.opacity = '0';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 300); // Attendi fine transizione
}

// Cliccando il toast torni alla home per vedere il file
toast.addEventListener('click', () => {
    hideToast();
    if (typeof goHome === 'function') {
        goHome();
    }
});

function copyText(text, btnElement) {
    navigator.clipboard.writeText(text).then(() => {
        const oldText = btnElement.innerText;
        btnElement.innerText = "✓ Copiato!";
        btnElement.style.color = "#2e7d32";
        setTimeout(() => {
            btnElement.innerText = oldText;
            btnElement.style.color = "";
        }, 1500);
    });
}

function downloadFile(dataUrl, fileName) {
    // Al mobile browser spesso serve che si crei un link e si simuli un click
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName || "StudyTunnel_File";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
    }, 100);
}