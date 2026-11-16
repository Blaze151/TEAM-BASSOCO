/* ==========================================================
   Página del mecánico
   El mecánico entra con el enlace de activación que le manda el admin
   (trae el token de GitHub y su ID) y con su PIN. Solo ve los vehículos
   que tiene asignados y solo puede:
     - agregar fotos a la etapa en la que está el servicio,
     - escribir su nota de esa etapa,
     - pedir la autorización del admin cuando cumple los requisitos.
   NUNCA cambia la etapa: eso lo hace el admin desde su panel.
   Los datos se leen y escriben igual que en el panel (API de GitHub sobre
   data/vehicles.json), tocando únicamente esos campos del servicio.
   ========================================================== */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const REPO_OWNER = "Blaze151", REPO_NAME = "TEAM-BASSOCO", REPO_BRANCH = "main";
  const DATA_PATH = "data/vehicles.json";
  const SESSION_KEY = "bassoco_mec_session";
  const UNLOCK_KEY = "bassoco_mec_unlock";
  const THEME_KEY = "bassoco_theme";
  const TALLER_NOMBRE = "Team Bassoco Grupo Automotor Integrado";

  const ETAPAS = {
    recibido: { label: "Recibido", icon: "📥" },
    diagnostico: { label: "Diagnóstico", icon: "🔍" },
    en_proceso: { label: "En proceso", icon: "🔧" },
    listo: { label: "Listo", icon: "✅" },
    recogido: { label: "Entregado", icon: "🚗" },
  };
  const ORDEN_ETAPAS = ["recibido", "diagnostico", "en_proceso", "listo", "recogido"];
  const ETAPAS_MECANICO = ["diagnostico", "en_proceso", "listo"];
  const TITULO_ETAPA = {
    diagnostico: "Fotos e información del diagnóstico",
    en_proceso: "Fotos e información del proceso",
    listo: "Fotos e información del vehículo listo para recoger",
  };
  const INVENTARIO = {
    antena: "Antena", espejo_lateral: "Espejo lateral", cristales: "Cristales", emblema: "Emblema",
    tapon_ruedas: "Tapón de ruedas", molduras_completas: "Molduras completas", tapon_gasolina: "Tapón de gasolina",
    gato: "Gato", maneral_gato: "Maneral de gato", llave_ruedas: "Llave de ruedas",
    estuche_herramientas: "Estuche de herramientas", triangulo_seguridad: "Triángulo de seguridad",
    llanta_refaccion: "Llanta de refacción", extinguidor: "Extinguidor",
  };

  let sesion = null;        // { t: token, m: id del mecánico }
  let db = null;
  let dbSha = null;
  let yo = null;            // registro del mecánico en db.mecanicos
  let vehiculoAbierto = null;   // id del vehículo en la vista de detalle
  let servicioAbierto = null;   // id del servicio que se abrió (por si el admin inicia otro)
  let pendientes = [];      // File[] de fotos por subir en la etapa actual
  let subidas = [];         // rutas ya subidas a GitHub que aún no quedan en vehicles.json
  let notaBorrador = null;  // texto de la nota mientras se escribe (para no perderlo al redibujar)
  let etapaTrabajo = null;  // etapa en la que estaba el servicio la última vez que se dibujó el detalle
  let guardando = false;

  /* ---------------- Utilidades ---------------- */

  function esc(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function rawUrl(path) {
    return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${path}`;
  }
  function fechaHora(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function showToast(msg, type, duration) {
    const el = document.createElement("div");
    el.className = "toast " + (type || "");
    el.textContent = msg;
    document.body.appendChild(el);
    positionToasts();
    setTimeout(() => { el.remove(); positionToasts(); }, duration || 3800);
  }
  function positionToasts() {
    const toasts = Array.from(document.querySelectorAll(".toast"));
    let bottom = 20;
    for (let i = toasts.length - 1; i >= 0; i--) {
      toasts[i].style.bottom = bottom + "px";
      bottom += (toasts[i].offsetHeight || 44) + 10;
    }
  }

  // GitHub Pages / raw a veces tarda en servir un archivo recién subido: se
  // reintenta con pausas cada vez más largas durante varios minutos (igual
  // que en el panel y en la ficha) antes de rendirse.
  const IMG_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000, 180000];
  window.__imgRetry = function (el) {
    const n = Number(el.dataset.retryN) || 0;
    if (n >= IMG_RETRY_DELAYS.length) {
      const fallback = document.createElement("div");
      fallback.className = "img-fallback";
      fallback.textContent = "🚗";
      if (el.parentElement) el.parentElement.classList.remove("img-retrying");
      el.replaceWith(fallback);
      return;
    }
    el.dataset.retryN = String(n + 1);
    if (el.parentElement) el.parentElement.classList.add("img-retrying");
    const base = el.dataset.baseSrc || el.src.split("?")[0];
    el.dataset.baseSrc = base;
    setTimeout(() => { el.src = base + "?r=" + n + "-" + Date.now(); }, IMG_RETRY_DELAYS[n]);
  };
  window.__imgLoaded = function (el) {
    if (el.parentElement) el.parentElement.classList.remove("img-retrying");
  };

  /* ---------------- Tema ---------------- */

  function updateThemeIcon() {
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    $("theme-toggle").textContent = isLight ? "☀️" : "🌙";
    const logo = $("brand-logo-img");
    if (logo) logo.src = logo.src.replace(/logo-(white|black)\.png/, isLight ? "logo-black.png" : "logo-white.png");
  }
  $("theme-toggle").addEventListener("click", () => {
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    if (isLight) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", "light");
    try { localStorage.setItem(THEME_KEY, isLight ? "dark" : "light"); } catch (e) {}
    updateThemeIcon();
  });
  updateThemeIcon();

  /* ---------------- Lightbox ---------------- */

  let lbFotos = [], lbIndice = 0, lbRecienAbierto = false;
  function lbPintar() {
    $("lightbox-img").src = lbFotos[lbIndice];
    const varias = lbFotos.length > 1;
    $("lightbox-prev").style.display = varias ? "flex" : "none";
    $("lightbox-next").style.display = varias ? "flex" : "none";
    $("lightbox-counter").style.display = varias ? "block" : "none";
    $("lightbox-counter").textContent = `${lbIndice + 1} / ${lbFotos.length}`;
  }
  function lbCerrar() { $("lightbox").classList.add("hidden"); $("lightbox-img").src = ""; }
  $("lightbox-close").addEventListener("click", lbCerrar);
  $("lightbox-prev").addEventListener("click", () => { lbIndice = (lbIndice - 1 + lbFotos.length) % lbFotos.length; lbPintar(); });
  $("lightbox-next").addEventListener("click", () => { lbIndice = (lbIndice + 1) % lbFotos.length; lbPintar(); });
  $("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox") && !lbRecienAbierto) lbCerrar(); });
  document.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const thumb = e.target.closest("[data-lb]");
    if (!thumb) return;
    lbFotos = JSON.parse(thumb.dataset.lb);
    lbIndice = Number(thumb.dataset.lbI) || 0;
    lbPintar();
    $("lightbox").classList.remove("hidden");
    lbRecienAbierto = true;
    setTimeout(() => { lbRecienAbierto = false; }, 600);
  });

  /* ---------------- API de GitHub ---------------- */

  async function githubRequest(path, options) {
    const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
      ...options,
      headers: {
        "Authorization": `Bearer ${sesion.t}`,
        "Accept": "application/vnd.github+json",
        ...(options && options.headers ? options.headers : {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.message || `Error de GitHub (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  function b64EncodeUnicode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64DecodeUnicode(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  async function loadDatabase() {
    const file = await githubRequest(`${DATA_PATH}?ref=${encodeURIComponent(REPO_BRANCH)}`, { method: "GET", cache: "no-store" });
    dbSha = file.sha;
    db = JSON.parse(b64DecodeUnicode(file.content.replace(/\n/g, "")));
    if (!db.vehicles) db.vehicles = {};
    yo = (Array.isArray(db.mecanicos) ? db.mecanicos : []).find((m) => m.id === sesion.m) || null;
  }
  async function hayCambiosRemotos() {
    const lista = await githubRequest(`data?ref=${encodeURIComponent(REPO_BRANCH)}`, { method: "GET", cache: "no-store" });
    const archivo = Array.isArray(lista) ? lista.find((x) => x.path === DATA_PATH) : null;
    return !archivo || archivo.sha !== dbSha;
  }
  // Guarda aplicando SOLO el cambio del mecánico sobre los datos más recientes
  // de GitHub. Si alguien más guardó justo antes (choque 409), vuelve a traer
  // los datos, reaplica el cambio y reintenta: nunca pisa lo que hizo el admin.
  async function guardarConReintento(mensaje, aplicar) {
    const intentos = 5;
    for (let intento = 1; intento <= intentos; intento++) {
      await loadDatabase();
      aplicar();
      try {
        const res = await githubRequest(DATA_PATH, {
          method: "PUT",
          body: JSON.stringify({ message: mensaje, content: b64EncodeUnicode(JSON.stringify(db, null, 2)), sha: dbSha, branch: REPO_BRANCH }),
        });
        dbSha = res.content.sha;
        return;
      } catch (err) {
        if (err.status !== 409 || intento === intentos) throw err;
        await new Promise((r) => setTimeout(r, 600 * intento));
      }
    }
  }

  /* ---------------- Fotos: compresión y HEIC (igual que el panel) ---------------- */

  function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 1400;
    quality = quality || 0.68;
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(objectUrl);
          if (!blob) return reject(new Error("No se pudo procesar la imagen"));
          resolve(blob);
        }, "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("No se pudo leer la imagen")); };
      img.src = objectUrl;
    });
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  function slugifyFilename(name) {
    return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  }
  function timestampSlug() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function looksLikeHeic(file) {
    const type = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    return type.includes("heic") || type.includes("heif") || /\.(heic|heif)$/.test(name);
  }
  function loadScriptWithRetry(src, isLoadedCheck, intentos) {
    intentos = intentos || 3;
    if (isLoadedCheck()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let intento = 0;
      function tryLoad() {
        intento++;
        const s = document.createElement("script");
        s.src = src + "?r=" + intento;
        s.onload = () => resolve();
        s.onerror = () => {
          s.remove();
          if (intento >= intentos) reject(new Error("No se pudo cargar " + src.split("/").pop() + " — revisa tu conexión."));
          else setTimeout(tryLoad, 500 * intento);
        };
        document.head.appendChild(s);
      }
      tryLoad();
    });
  }
  async function convertHeicToJpeg(file) {
    await loadScriptWithRetry("../assets/heic2any.min.js", () => !!window.heic2any);
    const result = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.85 });
    return Array.isArray(result) ? result[0] : result;
  }
  async function prepararFoto(file) {
    let trabajo = file;
    if (looksLikeHeic(file)) {
      showToast(`Convirtiendo ${file.name || "foto"}…`);
      trabajo = await convertHeicToJpeg(file);
    }
    return compressImage(trabajo);
  }

  /* ---------------- Sesión y PIN ---------------- */

  function leerEnlaceDeActivacion() {
    const m = /[#&]a=([A-Za-z0-9_-]+)/.exec(location.hash || "");
    if (!m) return false;
    // El token se quita de la barra de direcciones de inmediato.
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    try {
      const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const datos = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
      if (!datos || !datos.t || !datos.m || (datos.r && datos.r !== REPO_NAME)) return false;
      sesion = { t: datos.t, m: datos.m };
      localStorage.setItem(SESSION_KEY, JSON.stringify(sesion));
      try { localStorage.removeItem(UNLOCK_KEY); } catch (e) {}
      return true;
    } catch (e) {
      return false;
    }
  }
  function restaurarSesion() {
    try {
      const guardada = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (guardada && guardada.t && guardada.m) { sesion = guardada; return true; }
    } catch (e) {}
    return false;
  }
  // La sesión queda abierta en este celular hasta que el mecánico la cierre.
  // Se guarda la huella del NIP con el que entró: si el administrador genera un
  // NIP nuevo, la sesión deja de valer y hay que entrar otra vez.
  function desbloqueado() {
    try { return !!yo && localStorage.getItem(UNLOCK_KEY) === sesion.m + ":" + yo.pin_hash; } catch (e) { return false; }
  }
  async function sha256Hex(texto) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function pantallaMensaje(titulo, texto, botonReintentar) {
    $("btn-salir").style.display = "none";
    $("content").innerHTML = `
      <div class="card">
        <div class="card-title">${esc(titulo)}</div>
        <p style="color:var(--text-dim);font-size:13.5px;line-height:1.5;margin:0;">${esc(texto)}</p>
        ${botonReintentar ? `<button class="btn btn-block" id="btn-reintentar" style="margin-top:14px;">🔄 Reintentar</button>` : ""}
      </div>`;
    if (botonReintentar) $("btn-reintentar").addEventListener("click", iniciar);
  }

  let intentosPin = 0, bloqueoPinHasta = 0;
  function pantallaPin() {
    $("btn-salir").style.display = "none";
    $("content").innerHTML = `
      <div class="card">
        <div class="card-title">Hola, ${esc(yo.nombre)}</div>
        <p style="color:var(--text-dim);font-size:13.5px;margin-top:0;">Escribe tu NIP para entrar. Tu sesión se queda abierta en este celular hasta que la cierres.</p>
        <div class="form-group">
          <input type="password" id="pin-input" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="NIP" style="text-align:center;font-size:22px;letter-spacing:6px;">
        </div>
        <button class="btn btn-block" id="pin-entrar">Entrar</button>
        <p id="pin-error" style="color:var(--danger);font-size:12.5px;margin:10px 0 0;display:none;"></p>
      </div>`;
    const entrar = async () => {
      const errEl = $("pin-error");
      const ahora = Date.now();
      if (ahora < bloqueoPinHasta) {
        errEl.textContent = `Demasiados intentos. Espera ${Math.ceil((bloqueoPinHasta - ahora) / 1000)} segundos.`;
        errEl.style.display = "block";
        return;
      }
      const pin = $("pin-input").value.trim();
      if (!pin) return;
      const hash = await sha256Hex((yo.salt || "") + ":" + pin);
      if (hash !== yo.pin_hash) {
        intentosPin++;
        if (intentosPin >= 5) { bloqueoPinHasta = Date.now() + 30000; intentosPin = 0; }
        errEl.textContent = "NIP incorrecto.";
        errEl.style.display = "block";
        $("pin-input").value = "";
        return;
      }
      intentosPin = 0;
      try { localStorage.setItem(UNLOCK_KEY, sesion.m + ":" + yo.pin_hash); } catch (e) {}
      mostrarLista();
    };
    $("pin-entrar").addEventListener("click", entrar);
    $("pin-input").addEventListener("keydown", (e) => { if (e.key === "Enter") entrar(); });
    $("pin-input").focus();
  }

  /* ---------------- Datos del servicio que ve el mecánico ---------------- */

  function requisitos() {
    const guardados = (db && db.requisitos_mecanico) || {};
    const out = {};
    ETAPAS_MECANICO.forEach((etapa) => {
      const r = guardados[etapa] || {};
      const n = Number(r.min_fotos);
      out[etapa] = { min_fotos: Number.isFinite(n) && r.min_fotos !== null && r.min_fotos !== "" ? Math.max(0, Math.floor(n)) : 3, nota: r.nota !== false };
    });
    return out;
  }
  function misVehiculos() {
    return Object.values(db.vehicles || {}).filter((v) => {
      const s = v.servicio_actual;
      return s && Array.isArray(s.mecanicos) && s.mecanicos.includes(sesion.m) && s.estado !== "recogido";
    });
  }
  // Situación del trabajo del mecánico en un servicio, para la lista y el detalle.
  function situacion(s) {
    const mec = s.mec || {};
    if (!ETAPAS_MECANICO.includes(s.estado)) return { clave: "espera", txt: "En recepción: todavía no te toca", color: "var(--text-faint)" };
    if (mec.solicitud && mec.solicitud.etapa === s.estado) return { clave: "solicitado", txt: "⏳ Esperando autorización del administrador", color: "var(--yellow)" };
    if (mec.rechazo && mec.rechazo.etapa === s.estado) return { clave: "rechazado", txt: "✗ El administrador pidió correcciones", color: "var(--danger)" };
    if ((mec.autorizaciones || {})[s.estado]) return { clave: "autorizado", txt: "✅ Trabajo autorizado", color: "var(--green-bright)" };
    return { clave: "trabajando", txt: "🛠️ Te toca: sube fotos e información", color: "var(--text-dim)" };
  }

  /* ---------------- Lista de vehículos asignados ---------------- */

  function mostrarLista() {
    vehiculoAbierto = null;
    servicioAbierto = null;
    pendientes = [];
    subidas = [];
    notaBorrador = null;
    $("btn-salir").style.display = "inline-flex";
    const orden = { rechazado: 0, trabajando: 1, solicitado: 2, autorizado: 3, espera: 4 };
    const lista = misVehiculos().sort((a, b) => orden[situacion(a.servicio_actual).clave] - orden[situacion(b.servicio_actual).clave]);
    const req = requisitos();
    const filas = lista.length ? lista.map((v) => {
      const s = v.servicio_actual;
      const sit = situacion(s);
      const nFotos = ((s.adjuntos && s.adjuntos[s.estado] && s.adjuntos[s.estado].fotos) || []).length;
      const avance = ETAPAS_MECANICO.includes(s.estado) && sit.clave !== "autorizado" ? ` · Fotos ${nFotos}/${req[s.estado].min_fotos}` : "";
      const foto = v.foto_perfil
        ? `<div class="attach-thumb" style="width:54px;height:54px;flex-shrink:0;"><img src="${esc(rawUrl(v.foto_perfil))}" alt="" onerror="__imgRetry(this)" onload="__imgLoaded(this)"></div>`
        : `<div class="attach-thumb" style="width:54px;height:54px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px;">🚗</div>`;
      return `
        <div class="vlist-item" data-id="${esc(v.id)}" style="display:block;">
          <div style="display:flex;gap:10px;align-items:center;">
            ${foto}
            <div style="flex:1;min-width:0;">
              <div class="vlist-item-title">${esc(v.marca || "")} ${esc(v.modelo || "")} — ${esc(v.placas || "sin placa")}${v.numero_unidad ? " — Unidad " + esc(v.numero_unidad) : ""}</div>
              <div class="vlist-item-sub">${esc(s.tipo || "Servicio")}${s.folio ? " · Folio " + esc(s.folio) : ""}</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;">
            <span class="status-chip st-${esc(s.estado)}">${ETAPAS[s.estado].icon} ${ETAPAS[s.estado].label}</span>
            <span class="tag" style="color:${sit.color};">${esc(sit.txt)}${esc(avance)}</span>
          </div>
        </div>`;
    }).join("") : `<p style="color:var(--text-faint);font-size:13.5px;margin:0;">No tienes vehículos asignados en este momento.</p>`;

    $("content").innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div class="card-title" style="margin:0;">Hola, ${esc(yo.nombre)}</div>
          <button class="btn btn-outline btn-sm" id="btn-actualizar">🔄 Actualizar</button>
        </div>
        <p style="color:var(--text-faint);font-size:12px;margin:8px 0 0;">Estos son los vehículos que tienes asignados.</p>
      </div>
      <div class="card">
        <div class="card-title">Mis vehículos (${lista.length})</div>
        ${filas}
      </div>`;
    $("btn-actualizar").addEventListener("click", () => actualizar(true));
    $("content").querySelectorAll(".vlist-item").forEach((el) => el.addEventListener("click", () => abrirVehiculo(el.dataset.id)));
    window.scrollTo({ top: 0 });
  }

  let actualizando = false;
  async function actualizar(avisar) {
    if (actualizando || guardando || !sesion || !db) return;
    actualizando = true;
    try {
      if (await hayCambiosRemotos()) {
        await loadDatabase();
        if (!verificarAcceso()) return;
        redibujar();
      }
      if (avisar) showToast("Actualizado", "success", 1800);
    } catch (err) {
      if (avisar) showToast("No se pudo actualizar: revisa tu conexión", "error");
    } finally {
      actualizando = false;
    }
  }
  function redibujar() {
    if (!desbloqueado()) return;
    if (vehiculoAbierto) {
      const v = db.vehicles[vehiculoAbierto];
      const s = v && v.servicio_actual;
      const sigoAsignado = s && s.id === servicioAbierto && Array.isArray(s.mecanicos) && s.mecanicos.includes(sesion.m) && s.estado !== "recogido";
      if (!sigoAsignado) {
        showToast("Este vehículo ya no está asignado a ti", "", 6000);
        mostrarLista();
        return;
      }
      // No se redibuja mientras escribe, para no quitarle el foco del teclado.
      if (document.activeElement && document.activeElement.id === "mec-nota") return;
      pintarDetalle();
    } else {
      mostrarLista();
    }
  }
  function verificarAcceso() {
    if (!yo) { pantallaMensaje("Acceso no disponible", "Tu usuario ya no está dado de alta. Pide al administrador un enlace nuevo."); return false; }
    if (yo.activo === false) { pantallaMensaje("Acceso desactivado", "El administrador desactivó tu acceso. Habla con él para reactivarlo."); return false; }
    return true;
  }

  /* ---------------- Detalle del vehículo ---------------- */

  function abrirVehiculo(id) {
    const v = db.vehicles[id];
    if (!v || !v.servicio_actual) return;
    vehiculoAbierto = id;
    servicioAbierto = v.servicio_actual.id;
    etapaTrabajo = null;
    pendientes = [];
    subidas = [];
    notaBorrador = null;
    pintarDetalle();
    window.scrollTo({ top: 0 });
  }

  function filaDato(etiqueta, valor) {
    if (valor === null || valor === undefined || valor === "") return "";
    return `<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px;"><span style="color:var(--text-faint);">${esc(etiqueta)}</span><span style="text-align:right;font-weight:500;">${esc(valor)}</span></div>`;
  }
  function galeria(rutas) {
    if (!rutas.length) return "";
    const grupo = esc(JSON.stringify(rutas.map(rawUrl)));
    return `<div class="attach-gallery">${rutas.map((p, i) => `<div class="attach-thumb" data-lb="${grupo}" data-lb-i="${i}"><img src="${esc(rawUrl(p))}" alt="" onerror="__imgRetry(this)" onload="__imgLoaded(this)"></div>`).join("")}</div>`;
  }

  function htmlRecepcion(s) {
    const or = s.orden_recepcion || {};
    const inv = or.inventario || {};
    const fotos = (s.adjuntos && s.adjuntos.recibido && s.adjuntos.recibido.fotos) || [];
    const faltantes = [];
    [inv.exteriores || {}, inv.accesorios || {}].forEach((grupo) => {
      Object.keys(grupo).forEach((k) => { if (grupo[k] === "no" && INVENTARIO[k]) faltantes.push(INVENTARIO[k]); });
    });
    const presentes = [];
    [inv.exteriores || {}, inv.accesorios || {}].forEach((grupo) => {
      Object.keys(grupo).forEach((k) => { if (grupo[k] === "si" && INVENTARIO[k]) presentes.push(INVENTARIO[k]); });
    });
    const hayInventario = presentes.length || faltantes.length;
    const danos = (inv.danos_notas || "").trim();
    if (!fotos.length && !hayInventario && !danos && inv.gasolina == null) return "";
    return `
      <div class="card">
        <details class="card-details">
          <summary class="card-title">📥 Cómo llegó el vehículo (${fotos.length} fotos)</summary>
          <div class="card-details-body">
            ${danos ? `<div style="font-size:11px;color:var(--text-faint);">Daños anotados en recepción</div><div style="font-size:13px;white-space:pre-wrap;margin:3px 0 10px;">${esc(danos)}</div>` : ""}
            ${inv.gasolina != null && hayInventario ? filaDato("Gasolina", Math.round(Number(inv.gasolina) || 0) + "%") : ""}
            ${presentes.length ? `<div style="font-size:11px;color:var(--text-faint);margin-top:6px;">Llegó con</div><div style="font-size:12.5px;margin-top:2px;">${esc(presentes.join(", "))}</div>` : ""}
            ${faltantes.length && presentes.length ? `<div style="font-size:11px;color:var(--text-faint);margin-top:8px;">No traía</div><div style="font-size:12.5px;margin-top:2px;">${esc(faltantes.join(", "))}</div>` : ""}
            ${galeria(fotos)}
          </div>
        </details>
      </div>`;
  }
  function htmlTrabajos(s) {
    const items = ((s.cotizacion && s.cotizacion.items) || []).filter((it) => (it.concepto || "").trim());
    if (!items.length) return "";
    return `
      <div class="card">
        <div class="card-title">🧾 Trabajos de la cotización</div>
        ${items.map((it) => `<div style="display:flex;gap:10px;padding:6px 0;font-size:13px;border-bottom:1px solid rgba(128,128,128,0.12);"><span class="mono" style="color:var(--text-faint);flex-shrink:0;">${esc(Number(it.cantidad) || 1)} ×</span><span>${esc(it.concepto)}</span></div>`).join("")}
      </div>`;
  }

  function htmlEtapa(s, etapa) {
    const idxEtapa = ORDEN_ETAPAS.indexOf(etapa), idxActual = ORDEN_ETAPAS.indexOf(s.estado);
    const mec = s.mec || {};
    const fotos = ((s.adjuntos && s.adjuntos[etapa] && s.adjuntos[etapa].fotos) || []).filter((p) => !subidas.includes(p));
    const nota = (mec.notas || {})[etapa];
    const aut = (mec.autorizaciones || {})[etapa];

    if (idxEtapa > idxActual) {
      return `<div class="card" style="opacity:0.55;"><div class="card-title" style="margin:0;">🔒 ${ETAPAS[etapa].icon} ${ETAPAS[etapa].label}</div><p style="color:var(--text-faint);font-size:12px;margin:8px 0 0;">Se abre cuando el administrador autorice la etapa anterior.</p></div>`;
    }
    const cerrada = idxEtapa < idxActual || !!aut;
    if (cerrada) {
      return `
        <div class="card">
          <details class="card-details" ${etapa === s.estado ? "open" : ""}>
            <summary class="card-title">✅ ${ETAPAS[etapa].label} (${fotos.length} fotos)</summary>
            <div class="card-details-body">
              ${aut ? `<div style="font-size:12px;color:var(--green-bright);">Autorizado · ${esc(fechaHora(aut.fecha))}</div>` : ""}
              ${nota && (nota.texto || "").trim() ? `<div style="font-size:11px;color:var(--text-faint);margin-top:8px;">Nota de ${esc(nota.nombre || "")}</div><div style="font-size:13px;white-space:pre-wrap;margin-top:3px;">${esc(nota.texto)}</div>` : ""}
              ${galeria(fotos)}
            </div>
          </details>
        </div>`;
    }

    // Etapa en la que está el servicio: aquí trabaja el mecánico.
    const req = requisitos()[etapa];
    const sol = mec.solicitud && mec.solicitud.etapa === etapa ? mec.solicitud : null;
    const rech = mec.rechazo && mec.rechazo.etapa === etapa ? mec.rechazo : null;
    const textoNota = notaBorrador !== null ? notaBorrador : ((nota && nota.texto) || "");
    const totalFotos = fotos.length + subidas.length + pendientes.length;
    const fotosOk = totalFotos >= req.min_fotos;
    const notaOk = !req.nota || !!textoNota.trim();
    const siguiente = etapa === "listo" ? null : ETAPAS[ORDEN_ETAPAS[idxEtapa + 1]].label;

    const grupo = esc(JSON.stringify(fotos.concat(subidas).map(rawUrl)));
    const miniaturas = fotos.concat(subidas).map((p, i) => `<div class="attach-thumb" data-lb="${grupo}" data-lb-i="${i}"><img src="${esc(rawUrl(p))}" alt="" onerror="__imgRetry(this)" onload="__imgLoaded(this)"></div>`).join("")
      + pendientes.map((f, i) => `<div class="attach-thumb pending attach-thumb-remove"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" data-quitar-pendiente="${i}" title="Quitar">×</button></div>`).join("");

    return `
      <div class="card" id="etapa-activa">
        <div class="card-title">${ETAPAS[etapa].icon} ${esc(TITULO_ETAPA[etapa])}</div>
        ${rech ? `<div style="padding:10px;border-radius:10px;border:1px solid var(--danger);margin-bottom:12px;"><div style="font-size:13px;font-weight:600;color:var(--danger);">✗ El administrador pidió correcciones · ${esc(fechaHora(rech.fecha))}</div>${rech.motivo ? `<div style="font-size:13px;margin-top:4px;white-space:pre-wrap;">${esc(rech.motivo)}</div>` : ""}</div>` : ""}
        ${sol ? `<div style="padding:10px;border-radius:10px;border:1px solid var(--yellow);margin-bottom:12px;font-size:13px;font-weight:600;color:var(--yellow);">⏳ Autorización pedida el ${esc(fechaHora(sol.fecha))}. Espera a que el administrador la apruebe.${enlaceAvisoAdmin(db.vehicles[vehiculoAbierto], etapa) ? `<a class="btn btn-sm" id="wa-avisar-otra-vez" href="${esc(enlaceAvisoAdmin(db.vehicles[vehiculoAbierto], etapa))}" rel="noopener" target="_blank" style="margin-top:9px;display:inline-flex;">💬 Avisar al administrador por WhatsApp</a>` : ""}</div>` : ""}

        <div class="attach-input-row">
          <button type="button" class="btn btn-outline btn-sm" id="btn-foto-camara">📷 Tomar foto</button>
          <button type="button" class="btn btn-outline btn-sm" id="btn-foto-galeria">🖼️ Fototeca</button>
          <input type="file" id="foto-camara" accept="image/*" capture="environment">
          <input type="file" id="foto-galeria" accept="image/*" multiple>
        </div>
        <div class="attach-gallery">${miniaturas}</div>
        ${pendientes.length ? `<p style="font-size:11.5px;color:var(--yellow);margin:8px 0 0;">${pendientes.length} foto(s) sin subir todavía: presiona «Guardar avance».</p>` : ""}

        <div class="form-group" style="margin-top:14px;">
          <label class="form-label">Nota para el administrador${req.nota ? "" : " (opcional)"}</label>
          <textarea id="mec-nota" style="min-height:96px;" placeholder="Qué encontraste, qué hiciste, qué falta…">${esc(textoNota)}</textarea>
        </div>

        <div style="font-size:12.5px;line-height:1.7;margin-bottom:12px;">
          <div id="req-fotos" style="color:${fotosOk ? "var(--green-bright)" : "var(--text-dim)"};">${fotosOk ? "✓" : "○"} Fotos: ${totalFotos} de ${req.min_fotos} como mínimo</div>
          ${req.nota ? `<div id="req-nota" style="color:${notaOk ? "var(--green-bright)" : "var(--text-dim)"};">${notaOk ? "✓" : "○"} Nota escrita</div>` : ""}
        </div>

        <button type="button" class="btn btn-outline btn-block" id="btn-guardar-avance">💾 Guardar avance</button>
        ${sol ? "" : `<button type="button" class="btn btn-block" id="btn-pedir-autorizacion" style="margin-top:10px;" ${fotosOk && notaOk ? "" : "disabled"}>📨 ${siguiente ? "Pedir autorización para pasar a " + esc(siguiente) : "Pedir autorización: trabajo terminado"}</button>
        <p id="hint-autorizacion" style="font-size:11px;color:var(--text-faint);margin:6px 0 0;text-align:center;${fotosOk && notaOk ? "display:none;" : ""}">Completa las fotos y la nota para poder pedir la autorización.</p>`}
      </div>`;
  }

  function pintarDetalle() {
    const v = db.vehicles[vehiculoAbierto];
    const s = v && v.servicio_actual;
    if (!s) { mostrarLista(); return; }
    if (etapaTrabajo && etapaTrabajo !== s.estado) {
      // El administrador cambió la etapa: la nota a medias era de la etapa anterior.
      notaBorrador = null;
      showToast(`El servicio pasó a «${ETAPAS[s.estado].label}»`, "", 5000);
    }
    etapaTrabajo = s.estado;
    const sit = situacion(s);
    const km = s.km || v.km_actual;
    const foto = v.foto_perfil
      ? `<div class="attach-thumb" data-lb="${esc(JSON.stringify([rawUrl(v.foto_perfil)]))}" data-lb-i="0" style="width:72px;height:72px;flex-shrink:0;"><img src="${esc(rawUrl(v.foto_perfil))}" alt="" onerror="__imgRetry(this)" onload="__imgLoaded(this)"></div>`
      : "";
    $("content").innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <button class="btn btn-outline btn-sm" id="btn-volver">← Mis vehículos</button>
        <button class="btn btn-outline btn-sm" id="btn-actualizar">🔄 Actualizar</button>
      </div>
      <div style="height:14px;"></div>

      <div class="card">
        <div style="display:flex;gap:12px;align-items:center;">
          ${foto}
          <div style="flex:1;min-width:0;">
            <div class="vlist-item-title" style="font-size:16px;">${esc(v.marca || "")} ${esc(v.modelo || "")}${v.anio ? " " + esc(v.anio) : ""}</div>
            <div class="vlist-item-sub">${esc(v.placas || "sin placa")}${v.numero_unidad ? " · Unidad " + esc(v.numero_unidad) : ""}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 6px;">
          <span class="status-chip st-${esc(s.estado)}">${ETAPAS[s.estado].icon} ${ETAPAS[s.estado].label}</span>
          <span class="tag" style="color:${sit.color};">${esc(sit.txt)}</span>
        </div>
        ${filaDato("Cliente", v.cliente_nombre)}
        ${filaDato("Folio", s.folio)}
        ${filaDato("Kilometraje", km ? Number(km).toLocaleString("es-MX") + " km" : "")}
        ${filaDato("Color", v.color)}
        ${filaDato("Versión / motor", v.version)}
        ${filaDato("Combustible", v.combustible)}
        ${filaDato("VIN", v.vin)}
      </div>

      <div class="card">
        <div class="card-title">🔧 Servicio</div>
        ${filaDato("Tipo de servicio", s.tipo)}
        ${filaDato("Entrega aproximada", s.tiempo_entrega_aprox)}
        ${(s.descripcion || "").trim() ? `<div style="font-size:11px;color:var(--text-faint);margin-top:8px;">Descripción</div><div style="font-size:13px;white-space:pre-wrap;margin-top:3px;">${esc(s.descripcion)}</div>` : ""}
        ${(s.nota_interna || "").trim() ? `<div style="font-size:11px;color:var(--yellow);margin-top:10px;">Nota interna del taller</div><div style="font-size:13px;white-space:pre-wrap;margin-top:3px;">${esc(s.nota_interna)}</div>` : ""}
      </div>

      ${htmlTrabajos(s)}
      ${htmlRecepcion(s)}
      ${ETAPAS_MECANICO.map((etapa) => htmlEtapa(s, etapa)).join("")}
    `;
    $("btn-volver").addEventListener("click", () => {
      if ((pendientes.length || subidas.length || notaBorrador !== null) && !confirm("Tienes fotos o una nota sin guardar. ¿Salir sin guardar?")) return;
      mostrarLista();
    });
    $("btn-actualizar").addEventListener("click", () => actualizar(true));
    conectarEtapaActiva(s);
  }

  function conectarEtapaActiva(s) {
    if (!$("etapa-activa")) return;
    const etapa = s.estado;
    $("btn-foto-camara").addEventListener("click", () => $("foto-camara").click());
    $("btn-foto-galeria").addEventListener("click", () => $("foto-galeria").click());
    const alElegir = (e) => {
      const archivos = Array.from(e.target.files || []).filter((f) => (f.type || "").startsWith("image/") || looksLikeHeic(f));
      e.target.value = "";
      if (!archivos.length) return;
      pendientes = pendientes.concat(archivos);
      pintarDetalle();
      const destino = $("etapa-activa");
      if (destino) destino.scrollIntoView({ block: "start" });
    };
    $("foto-camara").addEventListener("change", alElegir);
    $("foto-galeria").addEventListener("change", alElegir);
    $("etapa-activa").addEventListener("click", (e) => {
      const quitar = e.target.closest("[data-quitar-pendiente]");
      if (!quitar || guardando) return;
      pendientes.splice(Number(quitar.dataset.quitarPendiente), 1);
      pintarDetalle();
    });
    $("mec-nota").addEventListener("input", (e) => {
      notaBorrador = e.target.value;
      actualizarRequisitosEnVivo(s);
    });
    $("btn-guardar-avance").addEventListener("click", () => guardarAvance(etapa, false));
    if ($("btn-pedir-autorizacion")) $("btn-pedir-autorizacion").addEventListener("click", () => guardarAvance(etapa, true));
  }
  // Actualiza el aviso de requisitos y el botón sin redibujar (para no perder el foco al escribir).
  function actualizarRequisitosEnVivo(s) {
    const req = requisitos()[s.estado];
    const notaOk = !req.nota || !!(notaBorrador || "").trim();
    const guardadas = ((s.adjuntos && s.adjuntos[s.estado] && s.adjuntos[s.estado].fotos) || []).filter((p) => !subidas.includes(p)).length;
    const fotosOk = guardadas + subidas.length + pendientes.length >= req.min_fotos;
    const elNota = $("req-nota");
    if (elNota) {
      elNota.style.color = notaOk ? "var(--green-bright)" : "var(--text-dim)";
      elNota.textContent = (notaOk ? "✓" : "○") + " Nota escrita";
    }
    const btn = $("btn-pedir-autorizacion");
    if (btn) btn.disabled = !(fotosOk && notaOk);
    const hint = $("hint-autorizacion");
    if (hint) hint.style.display = fotosOk && notaOk ? "none" : "block";
  }

  /* ---------------- Guardar avance / pedir autorización ---------------- */

  async function guardarAvance(etapa, pedir) {
    if (guardando) return;
    const idVehiculo = vehiculoAbierto, idServicio = servicioAbierto;
    const texto = ($("mec-nota") ? $("mec-nota").value : (notaBorrador || "")).trim();
    notaBorrador = texto;
    if (pedir && !confirm("¿Pedir la autorización del administrador para esta etapa?")) return;

    guardando = true;
    const btnGuardar = $("btn-guardar-avance"), btnPedir = $("btn-pedir-autorizacion");
    const ponerEstado = (txt) => { if (btnGuardar) { btnGuardar.disabled = true; btnGuardar.textContent = txt; } if (btnPedir) btnPedir.disabled = true; };
    let omitidas = 0;
    let resultado = null;
    try {
      // 1) Fotos: una por una, NUNCA en paralelo (en paralelo GitHub responde
      //    con choques 409 falsos). Cada una que sube sale de "pendientes" y
      //    queda en "subidas", así un reintento no la vuelve a subir.
      const v0 = db.vehicles[idVehiculo] || {};
      const total = pendientes.length;
      let n = 0;
      while (pendientes.length) {
        const file = pendientes[0];
        n++;
        ponerEstado(`Subiendo foto ${n} de ${total}…`);
        let blob = null;
        try { blob = await prepararFoto(file); } catch (err) { omitidas++; pendientes.shift(); continue; }
        const base64 = await blobToBase64(blob);
        const nombre = `${timestampSlug()}-${etapa}-m${n}-${slugifyFilename((file.name || "foto").replace(/\.[^.]+$/, ""))}.jpg`;
        const ruta = `uploads/${idVehiculo}/${nombre}`;
        await githubRequest(ruta, {
          method: "PUT",
          body: JSON.stringify({ message: `Agregar foto (${ETAPAS[etapa].label}) — ${v0.placas || idVehiculo} [${yo.nombre}]`, content: base64, branch: REPO_BRANCH }),
        });
        subidas.push(ruta);
        pendientes.shift();
        if (pendientes.length) await new Promise((r) => setTimeout(r, 120));
      }

      // 2) Registro: se aplica solo lo del mecánico sobre los datos más recientes.
      ponerEstado("Guardando…");
      const ahora = new Date().toISOString();
      await guardarConReintento(`${pedir ? "Solicitud de autorización" : "Avance del mecánico"} (${ETAPAS[etapa].label}) — ${v0.placas || idVehiculo} [${yo.nombre}]`, () => {
        resultado = { ok: false, motivo: "" };
        const v = db.vehicles[idVehiculo];
        const s = v && v.servicio_actual;
        if (!s || s.id !== idServicio) { resultado.motivo = "El servicio ya no está activo."; return; }
        if (!yo || yo.activo === false || !Array.isArray(s.mecanicos) || !s.mecanicos.includes(sesion.m)) { resultado.motivo = "Este vehículo ya no está asignado a ti."; return; }
        if (!s.adjuntos) s.adjuntos = {};
        if (!s.adjuntos[etapa]) s.adjuntos[etapa] = { fotos: [], documentos: [] };
        if (!Array.isArray(s.adjuntos[etapa].fotos)) s.adjuntos[etapa].fotos = [];
        subidas.forEach((ruta) => { if (!s.adjuntos[etapa].fotos.includes(ruta)) s.adjuntos[etapa].fotos.push(ruta); });
        if (!s.mec) s.mec = { notas: {}, solicitud: null, autorizaciones: {}, rechazo: null };
        if (!s.mec.notas) s.mec.notas = {};
        const anterior = s.mec.notas[etapa];
        if (texto !== ((anterior && anterior.texto) || "")) {
          if (texto) s.mec.notas[etapa] = { texto, por: sesion.m, nombre: yo.nombre, fecha: ahora };
          else delete s.mec.notas[etapa];
        }
        s.actualizado = todayISO();
        resultado.ok = true;
        if (pedir) {
          const req = requisitos()[etapa];
          if (s.estado !== etapa) { resultado.aviso = "El administrador ya cambió la etapa: se guardaron tus fotos y tu nota, pero no se envió la solicitud."; return; }
          if (s.adjuntos[etapa].fotos.length < req.min_fotos || (req.nota && !texto)) { resultado.aviso = "Faltan requisitos de esta etapa: se guardó tu avance, pero no se envió la solicitud."; return; }
          s.mec.solicitud = { etapa, por: sesion.m, nombre: yo.nombre, fecha: ahora };
          if (s.mec.rechazo && s.mec.rechazo.etapa === etapa) s.mec.rechazo = null;
          resultado.solicitado = true;
        }
      });

      if (!resultado.ok) {
        showToast(resultado.motivo, "error", 8000);
        subidas = [];
        notaBorrador = null;
        mostrarLista();
        return;
      }
      subidas = [];
      notaBorrador = null;
      if (omitidas) showToast(`${omitidas} foto(s) no se pudieron procesar y no se subieron`, "error", 9000);
      if (resultado.aviso) showToast(resultado.aviso, "error", 9000);
      else showToast(resultado.solicitado ? "Solicitud enviada al administrador" : "Avance guardado", "success");
      pintarDetalle();
      if (resultado.solicitado) ofrecerAvisoWhatsApp(db.vehicles[idVehiculo], etapa);
    } catch (err) {
      const sinPermiso = err.status === 401 || err.status === 403;
      showToast(sinPermiso
        ? "Tu acceso ya no es válido. Pide al administrador un enlace nuevo."
        : `No se pudo guardar: ${err.message || "revisa tu conexión"}. Tus fotos siguen aquí: presiona Guardar otra vez.`, "error", 10000);
      pintarDetalle();
    } finally {
      guardando = false;
    }
  }

  // Toda la comunicación con el administrador va por WhatsApp: al terminar una
  // etapa se le avisa con el mensaje ya escrito (WhatsApp no deja mandarlo solo).
  function enlaceAvisoAdmin(v, etapa) {
    const numero = String((db.taller && (db.taller.whatsapp || db.taller.telefono)) || "").replace(/\D/g, "");
    if (!numero) return "";
    const s = v.servicio_actual;
    const idx = ORDEN_ETAPAS.indexOf(etapa);
    const cierre = etapa === "listo"
      ? "El vehículo está listo para recoger. Falta tu autorización en el panel."
      : `Falta tu autorización en el panel para iniciar la siguiente: ${ETAPAS[ORDEN_ETAPAS[idx + 1]].label}.`;
    const texto = `Hola, soy ${yo.nombre}. Ya terminé la etapa de ${ETAPAS[etapa].label} del ${(v.marca || "") + " " + (v.modelo || "")} (placas ${v.placas || "s/p"})${v.numero_unidad ? ", unidad " + v.numero_unidad : ""}${s.folio ? ", folio " + s.folio : ""}: ya subí las fotos y la información. ${cierre}`;
    return `https://wa.me/${numero.length === 10 ? "52" + numero : numero}?text=${encodeURIComponent(texto.replace(/\s+/g, " "))}`;
  }
  function ofrecerAvisoWhatsApp(v, etapa) {
    const enlace = enlaceAvisoAdmin(v, etapa);
    if (!enlace) return;
    const overlay = document.createElement("div");
    overlay.className = "wa-prompt-overlay";
    overlay.innerHTML = `
      <div class="card wa-prompt-card">
        <div class="card-title">📨 Solicitud enviada</div>
        <p style="font-size:13.5px;color:var(--text-dim);margin:0 0 16px;line-height:1.5;">Ahora avísale al administrador por WhatsApp para que la revise y autorice la siguiente etapa.</p>
        <div class="actions-row" style="flex-wrap:wrap;">
          <a class="btn" href="${esc(enlace)}" rel="noopener" target="_blank" id="wa-avisar">💬 Avisar por WhatsApp</a>
          <button class="btn btn-outline" id="wa-cerrar">Ahora no</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    overlay.querySelector("#wa-cerrar").addEventListener("click", cerrar);
    overlay.querySelector("#wa-avisar").addEventListener("click", () => setTimeout(cerrar, 250));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cerrar(); });
  }

  /* ---------------- Inicio ---------------- */

  $("btn-salir").addEventListener("click", () => {
    if (!confirm((pendientes.length || subidas.length) ? "Tienes fotos sin guardar. ¿Cerrar sesión de todos modos?" : "¿Cerrar sesión? Para volver a entrar necesitarás tu NIP.")) return;
    try { localStorage.removeItem(UNLOCK_KEY); } catch (e) {}
    pantallaPin();
  });
  window.addEventListener("beforeunload", (e) => {
    if (!pendientes.length && !subidas.length) return;
    e.preventDefault();
    e.returnValue = "";
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) actualizar(false); });
  setInterval(() => { if (!document.hidden) actualizar(false); }, 60000);

  async function iniciar() {
    const activadoAhora = leerEnlaceDeActivacion();
    if (!activadoAhora && !sesion && !restaurarSesion()) {
      pantallaMensaje("Acceso de mecánicos", `Para entrar necesitas el enlace de acceso que te manda el administrador de ${TALLER_NOMBRE}. Ábrelo en este celular y entra con tu NIP.`);
      return;
    }
    $("content").innerHTML = `<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>`;
    try {
      await loadDatabase();
    } catch (err) {
      if (err.status === 401 || err.status === 403 || err.status === 404) {
        pantallaMensaje("Acceso no válido", "El acceso guardado en este celular ya no funciona. Pide al administrador un enlace nuevo.");
      } else {
        pantallaMensaje("Sin conexión", "No se pudo conectar. Revisa tu señal e inténtalo otra vez.", true);
      }
      return;
    }
    if (!verificarAcceso()) return;
    if (desbloqueado()) mostrarLista();
    else pantallaPin();
  }
  iniciar();
})();
