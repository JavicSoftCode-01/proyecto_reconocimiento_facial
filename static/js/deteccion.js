
document.addEventListener('DOMContentLoaded', async function () {
  console.log('DOM fully loaded and parsed. Starting v3.3 detection script.');

  // --- Elementos del DOM ---
  const video = document.getElementById('video');
  const canvas = document.getElementById('canvas');
  const loadingMessage = document.getElementById('loadingMessage');

  // --- Configuración ---
  const displaySize = {width: 640, height: 480};
  const detectionIntervalMs = 50;
  const matchThreshold = 0.6; // Distancia máxima para considerar un match con un usuario registrado

  // --- Estado de la Aplicación ---
  let labeledDescriptors = null;
  let faceMatcher = null;
  let stream = null;
  let detectionIntervalId = null;

  // --- Constantes para Confirmación, Suavizado y Persistencia ---
  const REQUIRED_CONSECUTIVE_FRAMES_GENERAL = 3; // Umbral general para acciones rápidas (ej: detección inicial)
  const REQUIRED_CONSECUTIVE_FRAMES_COVERED = 8; // Umbral más alto para "rostro cubierto" (ej: 8 frames = 400ms)
  const REQUIRED_CONSECUTIVE_FRAMES_UNREGISTERED = 5; // Umbral para considerar un desconocido "estable" (ej: 5 frames = 250ms)

  const SMOOTHING_ALPHA = 0.25; // Ligeramente más suavizado (más cerca de 0)
  const MAX_MATCH_DISTANCE = 80; // Distancia máxima para emparejar caras entre frames. Ayuda con movimientos rápidos.
  const MAX_MISSING_FRAMES = 10; // Número máximo de frames que una cara puede estar ausente antes de dejar de seguirla (ej: 10 frames = 500ms)

  // --- Configuración para Detección de Manchas ---
  const SKIN_TONE_THRESHOLD = 15; // Reducido para mayor sensibilidad
  const REQUIRED_CONSECUTIVE_FRAMES_MANCHA = 5; // Umbral de frames consecutivos para confirmar una mancha (250ms)
  const MANCHA_ANNOUNCE_COOLDOWN_MS = 10000; // Cooldown para evitar spam de mensajes de "mancha detectada"
  const GRID_SIZE = 4; // Dividir la cara en una cuadrícula 4x4 para análisis localizado

  // --- Estado para Detección de Manchas ---
  let consecutiveFramesMancha = 0; // Contador de frames consecutivos con mancha detectada
  let lastManchaAnnounceTime = 0; // Última vez que se anunció "mancha detectada"
  let userReferenceImages = {}; // Caché de imágenes de referencia por usuario (id: [img1, img2, ...])

  // --- Estado de Detección, Suavizado y Lógica de Anuncios ---
  let consecutiveFramesState = {
    noFace: 0, coveredFace: 0, unregisteredFace: 0,
    closingWarningShown: false, recognizedFaces: {},
  };
  const MAX_CONSECUTIVE_NO_FACE = Math.ceil(30 * 1000 / detectionIntervalMs); // 30 segundos sin cara
  const WARNING_NO_FACE_FRAMES = Math.ceil(15 * 1000 / detectionIntervalMs); // Advertencia a los 15 segundos

  // previousSmoothedData ahora almacenará objetos con 'missingFrames'
  let previousSmoothedData = [];
  let nextFaceId = 0; // ID temporal para seguimiento de caras en la sesión
  let currentFrame = 0;

  // <<< MEJORA: Saludo Único por Sesión >>>
  let greetedUserIds = new Set(); // Almacena IDs de usuarios ya saludados en esta sesión

  // <<< MEJORA: Caché para No Registrados (Persistente y de Sesión) >>>
  const UNREGISTERED_STORAGE_KEY = 'unregisteredFaceHashes_v2'; // Cambiar si la estructura del hash cambia (v2 por usar más valores)
  const UNREGISTERED_EXPIRY_KEY = 'unregisteredFaceExpiry_v2';
  const CACHE_EXPIRATION_MINUTES = 60; // Caras no registradas se "olvidan" después de 60 minutos
  let unregisteredCache = new Set(); // Caché en memoria, cargada desde localStorage (para persistencia)
  let announcedUnregisteredHashes = new Set(); // Caché en memoria para hashes ya anunciados en ESTA sesión

  // --- Cooldowns para Mensajes ---
  const UNCOVER_FACE_COOLDOWN_MS = 8000; // Ligeramente más largo
  // Cooldown GENERAL para anuncios de "No Registrado" para evitar spam si aparecen varios NUEVOS a la vez
  const UNREGISTERED_GENERAL_COOLDOWN_MS = 10000; // Ligeramente más largo

  let lastMessageTime = {
    uncoverFace: 0,
    unregisteredAnnounce: 0, // Cooldown general para el anuncio
  };

  // --- Cola Unificada de Mensajes y Web Speech API ---
  const messageQueue = [];
  let isProcessingMessage = false;
  let currentToastElement = null;
  const synth = window.speechSynthesis;
  let spanishVoice = null;
  let voiceInitializationAttempted = false;

  // --- Funciones para Detección de Manchas ---

  // Convertir RGB a HSV
  function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h, s, v;

    // Calcular valor (V)
    v = max;

    // Calcular saturación (S)
    s = max === 0 ? 0 : delta / max;

    // Calcular tono (H)
    if (delta === 0) {
      h = 0;
    } else if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h = Math.round(h * 60);
    if (h < 0) h += 360;

    return {h, s, v};
  }

  // Normalizar Iluminación
  function normalizeBrightness(imageData) {
    const pixels = imageData.data;
    let totalBrightness = 0;
    let pixelCount = 0;

    // Calcular brillo promedio
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const brightness = (r + g + b) / 3;
      totalBrightness += brightness;
      pixelCount++;
    }

    const avgBrightness = totalBrightness / pixelCount;
    const targetBrightness = 128; // Brillo objetivo (mitad del rango 0-255)

    // Normalizar
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = Math.min(255, Math.max(0, pixels[i] * (targetBrightness / avgBrightness))); // R
      pixels[i + 1] = Math.min(255, Math.max(0, pixels[i + 1] * (targetBrightness / avgBrightness))); // G
      pixels[i + 2] = Math.min(255, Math.max(0, pixels[i + 2] * (targetBrightness / avgBrightness))); // B
    }

    return imageData;
  }

  // Detectar Diferencias de Tonalidad por Regiones
  async function detectSkinToneDifference(video, detectionBox, referenceImages) {
    if (!referenceImages || referenceImages.length === 0) return false;

    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');

    // Ajustar el tamaño del canvas al área de la cara detectada
    const {x, y, width, height} = detectionBox;
    tempCanvas.width = width;
    tempCanvas.height = height;

    // Extraer el área de la cara del video
    tempCtx.drawImage(video, x, y, width, height, 0, 0, width, height);
    let videoImageData = tempCtx.getImageData(0, 0, width, height);
    videoImageData = normalizeBrightness(videoImageData); // Normalizar iluminación
    const videoPixels = videoImageData.data;

    // Calcular el promedio de tonalidad (V en HSV) por regiones en la imagen actual
    const regionWidth = width / GRID_SIZE;
    const regionHeight = height / GRID_SIZE;
    let videoRegionsV = [];

    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        let totalV = 0;
        let pixelCount = 0;

        // Analizar píxeles en la región actual
        for (let i = Math.floor(row * regionHeight); i < (row + 1) * regionHeight; i++) {
          for (let j = Math.floor(col * regionWidth); j < (col + 1) * regionWidth; j++) {
            const pixelIndex = (i * width + j) * 4;
            if (pixelIndex >= videoPixels.length) continue;

            const r = videoPixels[pixelIndex];
            const g = videoPixels[pixelIndex + 1];
            const b = videoPixels[pixelIndex + 2];
            const {v} = rgbToHsv(r, g, b);
            totalV += v;
            pixelCount++;
          }
        }

        const avgV = pixelCount > 0 ? totalV / pixelCount : 0;
        videoRegionsV.push(avgV);
      }
    }

    // Calcular el promedio de tonalidad (V en HSV) por regiones en las imágenes de referencia
    let referenceRegionsV = new Array(GRID_SIZE * GRID_SIZE).fill(0);
    let totalReferenceImages = 0;

    for (const refImage of referenceImages) {
      tempCanvas.width = refImage.width;
      tempCanvas.height = refImage.height;
      tempCtx.drawImage(refImage, 0, 0);
      let refImageData = tempCtx.getImageData(0, 0, refImage.width, refImage.height);
      refImageData = normalizeBrightness(refImageData); // Normalizar iluminación
      const refPixels = refImageData.data;

      const refRegionWidth = refImage.width / GRID_SIZE;
      const refRegionHeight = refImage.height / GRID_SIZE;

      for (let row = 0; row < GRID_SIZE; row++) {
        for (let col = 0; col < GRID_SIZE; col++) {
          let totalV = 0;
          let pixelCount = 0;

          for (let i = Math.floor(row * refRegionHeight); i < (row + 1) * refRegionHeight; i++) {
            for (let j = Math.floor(col * refRegionWidth); j < (col + 1) * refRegionWidth; j++) {
              const pixelIndex = (i * refImage.width + j) * 4;
              if (pixelIndex >= refPixels.length) continue;

              const r = refPixels[pixelIndex];
              const g = refPixels[pixelIndex + 1];
              const b = refPixels[pixelIndex + 2];
              const {v} = rgbToHsv(r, g, b);
              totalV += v;
              pixelCount++;
            }
          }

          const avgV = pixelCount > 0 ? totalV / pixelCount : 0;
          referenceRegionsV[row * GRID_SIZE + col] += avgV;
        }
      }
      totalReferenceImages++;
    }

    // Promediar las regiones de las imágenes de referencia
    referenceRegionsV = referenceRegionsV.map(v => v / totalReferenceImages);

    // Comparar las tonalidades por región
    let maxDifference = 0;
    for (let i = 0; i < videoRegionsV.length; i++) {
      const difference = Math.abs(videoRegionsV[i] - referenceRegionsV[i]) * 255; // Escalar a rango 0-255
      maxDifference = Math.max(maxDifference, difference);
    }

    console.log(`Máxima diferencia de tonalidad por región: ${maxDifference.toFixed(2)} (umbral: ${SKIN_TONE_THRESHOLD})`);

    return maxDifference > SKIN_TONE_THRESHOLD;
  }

  // Cargar Imágenes de Referencia del Usuario
  async function loadUserReferenceImages(userId) {
    if (userReferenceImages[userId]) return userReferenceImages[userId]; // Usar caché si ya están cargadas

    const images = [];
    const basePath = `/media/fotos_usuarios/user_${userId}/`;

    // Intentar cargar las 10 imágenes (rostro_1.jpg a rostro_10.jpg)
    for (let i = 1; i <= 10; i++) {
      const imgPath = `${basePath}rostro_${i}.jpg`;
      try {
        const img = new Image();
        img.crossOrigin = "Anonymous"; // Necesario si las imágenes están en un dominio diferente
        await new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error(`No se pudo cargar la imagen ${imgPath}`));
          img.src = imgPath;
        });
        images.push(img);
      } catch (error) {
        console.warn(`No se pudo cargar la imagen ${imgPath}: ${error.message}`);
      }
    }

    userReferenceImages[userId] = images;
    console.log(`Cargadas ${images.length} imágenes de referencia para el usuario ${userId}`);
    return images;
  }

  // --- Funciones de Síntesis de Voz ---
  function loadVoices() {
    if (!synth) return;
    const voices = synth.getVoices();
    spanishVoice = voices.find(voice => voice.lang === 'es-ES') ||
      voices.find(voice => voice.lang === 'es-MX') ||
      voices.find(voice => voice.lang.startsWith('es-')) ||
      voices.find(voice => voice.lang === 'es') ||
      voices.find(voice => voice.default && voice.lang.startsWith('es'));

    if (spanishVoice) {
      console.log(`Voz en español seleccionada: ${spanishVoice.name} (${spanishVoice.lang})`);
    } else if (voices.length > 0) {
      spanishVoice = voices.find(voice => voice.default) || voices[0];
      console.warn(`Voz en español no encontrada. Usando: ${spanishVoice.name} (${spanishVoice.lang})`);
    } else {
      console.warn('No hay voces de síntesis disponibles.');
      spanishVoice = null;
    }
  }

  function initializeVoice() {
    if (!voiceInitializationAttempted && synth) {
      voiceInitializationAttempted = true;
      loadVoices();
      if (synth.onvoiceschanged !== undefined) {
        synth.onvoiceschanged = loadVoices;
      }
      setTimeout(loadVoices, 500);
    }
  }

  async function processMessageQueue() {
    if (isProcessingMessage || messageQueue.length === 0) return;
    isProcessingMessage = true;
    const message = messageQueue.shift();

    if (currentToastElement && currentToastElement.parentNode) {
      try {
        currentToastElement.remove();
      } catch (e) {
        console.error("Error removing old toast:", e);
      }
      currentToastElement = null;
    }

    currentToastElement = showToast(message.text, message.type, message.duration);
    console.log(`[Queue] Showing toast: "${message.text}"`);

    let speechPromise = Promise.resolve();
    if (synth && message.speak) {
      if (!spanishVoice && !voiceInitializationAttempted) initializeVoice();
      if (!spanishVoice && synth.getVoices().length > 0) loadVoices();

      if (spanishVoice) {
        speechPromise = new Promise(resolve => {
          const utterance = new SpeechSynthesisUtterance(message.text);
          utterance.lang = spanishVoice.lang;
          utterance.voice = spanishVoice;
          utterance.rate = 1.0;
          utterance.pitch = 1.0;
          utterance.onend = () => {
            console.log(`[Queue] Speech finished: "${message.text}"`);
            resolve();
          };
          utterance.onerror = (event) => {
            console.error(`[Queue] Speech error:`, event.error);
            resolve();
          };
          setTimeout(() => {
            try {
              synth.speak(utterance);
            } catch (e) {
              console.error("Error synth.speak:", e);
              resolve();
            }
          }, 50);
        });
      } else {
        console.warn("No voice available for speech.");
      }
    }

    let minDuration = message.duration;
    let toastPromise = new Promise(resolve => setTimeout(resolve, minDuration));

    try {
      await Promise.all([speechPromise, toastPromise]);
    } catch (error) {
      console.error("[Queue] Error waiting for speech/toast:", error);
    }

    if (currentToastElement && currentToastElement.parentNode) {
      try {
        currentToastElement.style.opacity = '0';
        setTimeout(() => {
          try {
            currentToastElement.remove();
          } catch (e) {
          }
        }, 400);
      } catch (e) {
        console.error("Error fading/removing toast:", e);
      }
    }
    currentToastElement = null;

    isProcessingMessage = false;
    setTimeout(processMessageQueue, 200);
  }

  function enqueueMessage(text, type = 'info', duration = 4000, speak = true, important = false) {
    if (messageQueue.length > 0 && messageQueue[messageQueue.length - 1].text === text) return;
    if (currentToastElement && currentToastElement.textContent === text) return;

    const message = {text, type, duration, speak, important};
    if (important) messageQueue.unshift(message);
    else messageQueue.push(message);

    if (!isProcessingMessage) setTimeout(processMessageQueue, 0);
  }

  // --- Funciones de Control ---
  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      stream = null;
      console.log("Cámara detenida.");
    }
  }

  function stopDetectionInterval() {
    if (detectionIntervalId !== null) {
      clearInterval(detectionIntervalId);
      detectionIntervalId = null;
    }
  }

  function resetDetectionState() {
    consecutiveFramesState = {
      noFace: 0,
      coveredFace: 0,
      unregisteredFace: 0,
      closingWarningShown: false,
      recognizedFaces: {},
    };
    consecutiveFramesMancha = 0; // Resetear contador de manchas
    lastManchaAnnounceTime = 0; // Resetear cooldown de anuncios de manchas
    greetedUserIds.clear();
    announcedUnregisteredHashes.clear();

    lastMessageTime = {
      uncoverFace: 0,
      unregisteredAnnounce: 0,
    };
    currentFrame = 0;
    nextFaceId = 0;
    console.log("Estado de detección reseteado (saludos, anuncios y detección de manchas reiniciados).");
  }

  function closeDetection(reason = 'inactividad') {
    stopDetectionInterval();
    stopCamera();
    if (synth && synth.speaking) synth.cancel();
    messageQueue.length = 0;
    isProcessingMessage = false;
    if (currentToastElement) {
      try {
        currentToastElement.remove();
      } catch (e) {
      }
      currentToastElement = null;
    }
    previousSmoothedData = []; // Limpiar al cerrar completamente

    loadingMessage.textContent = `Detección cerrada por ${reason}.`;
    loadingMessage.style.display = 'block';
    enqueueMessage(`Detección cerrada por ${reason}.`, 'info', 5000);
    console.log(`Detección cerrada por ${reason}.`);
  }

  // --- Carga de Modelos y Datos ---
  async function loadModelsAndData() {
    enqueueMessage('Cargando modelos de IA...', 'info', 3000, false);
    loadingMessage.textContent = 'Cargando modelos...';
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('/static/face-api/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/static/face-api/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/static/face-api/models')
      ]);
      enqueueMessage('Modelos cargados.', 'success', 3000, false);
      loadingMessage.textContent = 'Cargando datos de usuarios...';
      enqueueMessage('Cargando datos de usuarios...', 'info', 3000, false);
      const response = await fetch('/usuarios/api/users/');
      if (!response.ok) throw new Error(`Error ${response.status}: ${response.statusText}`);
      const usersData = await response.json();
      if (usersData && usersData.length > 0) {
        const validLabeledDescriptors = [];
        for (const user of usersData) {
          if (user.descriptores && Array.isArray(user.descriptores) && user.descriptores.length > 0) {
            try {
              const descriptors = user.descriptores.map(d => Array.isArray(d) && d.length === 128 && d.every(val => typeof val === 'number') ? new Float32Array(d) : null).filter(d => d !== null);
              if (descriptors.length > 0) validLabeledDescriptors.push(new faceapi.LabeledFaceDescriptors(`${user.nombre_completo}|${user.id}`, descriptors));
              else console.warn(`No descriptors valid for user ID ${user.id} (${user.nombre_completo})`);
            } catch (e) {
              console.error(`Error processing descriptors for user ID ${user.id} (${user.nombre_completo}):`, e);
            }
          } else console.warn(`Invalid descriptors data format for user ID ${user.id} (${user.nombre_completo})`);
        }
        if (validLabeledDescriptors.length > 0) {
          labeledDescriptors = validLabeledDescriptors;
          faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, matchThreshold);
          const message = `Datos de ${labeledDescriptors.length} usuarios cargados.`;
          loadingMessage.textContent = message;
          enqueueMessage(message, 'success', 4000, false);
        } else {
          loadingMessage.textContent = 'No hay usuarios con datos faciales válidos.';
          enqueueMessage('Advertencia: No hay usuarios válidos para comparar.', 'warning', 8000, true);
          labeledDescriptors = [];
          faceMatcher = null;
        }
      } else {
        loadingMessage.textContent = 'No hay usuarios registrados.';
        enqueueMessage('No hay usuarios registrados.', 'info', 8000, true);
        labeledDescriptors = [];
        faceMatcher = null;
      }
    } catch (error) {
      console.error('Error loading models/data:', error);
      const errorMsg = `Error crítico al cargar: ${error.message}.`;
      loadingMessage.textContent = errorMsg;
      enqueueMessage(errorMsg, 'error', 15000, true, true);
      return false;
    }
    return true;
  }

  // --- Inicio de Video ---
  async function startVideo() {
    loadingMessage.textContent = 'Accediendo a la cámara...';
    enqueueMessage('Iniciando cámara...', 'info', 3000, false);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: {ideal: displaySize.width},
          height: {ideal: displaySize.height}
        }
      });
      video.srcObject = stream;
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => {
          video.width = displaySize.width;
          video.height = displaySize.height;
          canvas.width = displaySize.width;
          canvas.height = displaySize.height;
          video.play().then(resolve).catch(reject);
        };
        video.onerror = (err) => {
          console.error("Video error:", err);
          reject(new Error("Video metadata error."));
        };
      });
      loadingMessage.style.display = 'none';
      enqueueMessage('Cámara iniciada. Detectando...', 'success', 4000, true);
      resetDetectionState(); // Resetear estado al iniciar video
      initializeVoice();
    } catch (err) {
      console.error('Camera access error:', err);
      const errorMsg = `Error cámara: ${err.message}.`;
      loadingMessage.textContent = errorMsg;
      enqueueMessage(errorMsg, 'error', 15000, true, true);
      closeDetection('error cámara');
      return false;
    }
    return true;
  }

  // --- Función isFaceCovered ---
  function isFaceCovered(detection, landmarks) {
    if (!detection || !landmarks) return true;
    if (detection.score < 0.7) return true; // Umbral de score

    try {
      const jaw = landmarks.getJawOutline();
      const nose = landmarks.getNose();
      const mouth = landmarks.getMouth();
      const leftEye = landmarks.getLeftEye();
      const rightEye = landmarks.getRightEye();

      if (!jaw || jaw.length === 0 || !nose || nose.length === 0 || !mouth || mouth.length === 0 || !leftEye || leftEye.length === 0 || !rightEye || rightEye.length === 0) {
        return true;
      }
    } catch (e) {
      console.warn('Landmark check error:', e);
      return true;
    }
    return false;
  }

  // --- Funciones Auxiliares Suavizado ---
  function getBoxCenter(box) {
    if (!box) return null;
    return {x: box.x + box.width / 2, y: box.y + box.height / 2};
  }

  function getDistance(pointA, pointB) {
    if (!pointA || !pointB) return Infinity;
    return Math.sqrt(Math.pow(pointA.x - pointB.x, 2) + Math.pow(pointA.y - pointB.y, 2));
  }

  function smoothValue(current, previous, alpha) {
    if (typeof previous !== 'number' || isNaN(previous)) {
      return current; // Si el valor anterior no es válido, usar el actual
    }
    return alpha * current + (1 - alpha) * previous;
  }

  function smoothBox(currentBox, previousBox, alpha) {
    if (!previousBox || isNaN(previousBox.x) || isNaN(previousBox.y) || isNaN(previousBox.width) || isNaN(previousBox.height)) {
      return {...currentBox}; // Si el anterior no es válido, usar el actual sin suavizar
    }
    return {
      x: smoothValue(currentBox.x, previousBox.x, alpha),
      y: smoothValue(currentBox.y, previousBox.y, alpha),
      width: smoothValue(currentBox.width, previousBox.width, alpha),
      height: smoothValue(currentBox.height, previousBox.height, alpha)
    };
  }

  // --- Funciones para Caché de No Registrados ---
  function createDescriptorHash(descriptor) {
    if (!descriptor || descriptor.length !== 128) return null;
    let hashValue = 0;
    try {
      for (let i = 0; i < 128; i += 8) {
        hashValue += descriptor[i];
      }
      return Math.round(hashValue * 1000).toString();
    } catch (e) {
      console.error("Error creating descriptor hash:", e);
      return null;
    }
  }

  function loadUnregisteredCache() {
    try {
      const storedExpiry = localStorage.getItem(UNREGISTERED_EXPIRY_KEY);
      if (storedExpiry && Date.now() < parseInt(storedExpiry, 10)) {
        const storedHashes = localStorage.getItem(UNREGISTERED_STORAGE_KEY);
        if (storedHashes) {
          const parsedHashes = JSON.parse(storedHashes);
          if (Array.isArray(parsedHashes)) {
            unregisteredCache = new Set(parsedHashes);
            console.log(`Caché de no registrados persistente cargada: ${unregisteredCache.size} entradas.`);
          } else {
            console.warn("Datos de caché de no registrados en localStorage no son un array. Reiniciando caché.");
            unregisteredCache = new Set();
            localStorage.removeItem(UNREGISTERED_STORAGE_KEY);
            localStorage.removeItem(UNREGISTERED_EXPIRY_KEY);
          }
        } else {
          unregisteredCache = new Set();
          console.log("No hay caché de no registrados persistente en localStorage.");
        }
      } else {
        localStorage.removeItem(UNREGISTERED_STORAGE_KEY);
        localStorage.removeItem(UNREGISTERED_EXPIRY_KEY);
        unregisteredCache = new Set();
        console.log("Caché de no registrados persistente expirada o vacía.");
      }
    } catch (e) {
      console.error("Error cargando caché de no registrados:", e);
      unregisteredCache = new Set();
      try {
        localStorage.removeItem(UNREGISTERED_STORAGE_KEY);
        localStorage.removeItem(UNREGISTERED_EXPIRY_KEY);
      } catch (e2) {
        console.error("Error adicional limpiando localStorage:", e2);
      }
    }
    announcedUnregisteredHashes = new Set();
  }

  function saveUnregisteredCache() {
    try {
      const expiryTime = Date.now() + CACHE_EXPIRATION_MINUTES * 60 * 1000;
      localStorage.setItem(UNREGISTERED_STORAGE_KEY, JSON.stringify(Array.from(unregisteredCache)));
      localStorage.setItem(UNREGISTERED_EXPIRY_KEY, expiryTime.toString());
    } catch (e) {
      console.error("Error guardando caché de no registrados:", e);
      if (e.name === 'QuotaExceededError') {
        console.warn("LocalStorage posiblemente lleno. No se pudo guardar caché persistente.");
      }
    }
  }

  // --- Bucle Principal de Detección ---
  function runDetection() {
    if (!faceMatcher) {
      console.warn("No faceMatcher! Detection cannot run.");
      enqueueMessage('No hay datos de usuarios para detección.', 'warning', 5000, false);
      return;
    }
    if (video.readyState < 3) {
      console.warn("Video not ready, retry detection start...");
      setTimeout(runDetection, 500);
      return;
    }

    stopDetectionInterval();

    detectionIntervalId = setInterval(async () => {
      if (video.paused || video.ended || !stream || !stream.active || video.readyState < 3) {
        console.warn("Video stream inactive or not ready. Closing detection.");
        closeDetection('stream inactivo');
        return;
      }
      currentFrame++;

      try {
        // --- Detección ---
        const detectionOptions = new faceapi.TinyFaceDetectorOptions({inputSize: 416});
        const detections = await faceapi.detectAllFaces(video, detectionOptions).withFaceLandmarks().withFaceDescriptors();
        const resizedDetections = faceapi.resizeResults(detections, displaySize);
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, canvas.width, canvas.height);

        // --- Variables de Frame ---
        let currentFrameState = {
          hasFace: resizedDetections.length > 0,
          hasCovered: false,
          hasUnregistered: false,
          recognizedIds: new Set(),
          currentFrameUnknownHashes: new Set()
        };
        let currentRawData = []; // Datos crudos de las detecciones de ESTE frame
        let currentDetectedCenters = [];

        // --- 1. Análisis Crudo de Detecciones Actuales ---
        for (let i = 0; i < resizedDetections.length; i++) {
          const detection = resizedDetections[i];
          const box = detection.detection.box;
          const center = getBoxCenter(box);
          if (!center) continue;
          currentDetectedCenters[i] = center;

          const isCovered = isFaceCovered(detection.detection, detection.landmarks);

          let label = '...';
          let boxColor = '#888';
          let status = 'processing';
          let userId = null;
          let faceHash = null;

          if (isCovered) {
            status = 'covered';
            label = 'ROSTRO CUBIERTO';
            boxColor = '#ff9900'; // Naranja
            currentFrameState.hasCovered = true;
          } else {
            const bestMatch = faceMatcher.findBestMatch(detection.descriptor);

            if (bestMatch.label === 'unknown' || bestMatch.distance > matchThreshold) {
              status = 'unknown';
              label = 'PERSONA DESCONOCIDA';
              boxColor = '#dc0b00'; // Rojo
              currentFrameState.hasUnregistered = true;
              faceHash = createDescriptorHash(detection.descriptor);
              if (faceHash) {
                currentFrameState.currentFrameUnknownHashes.add(faceHash);
              }
            } else {
              status = 'recognized';
              [label, userId] = bestMatch.label.split('|');
              boxColor = '#00d02a'; // Verde
              currentFrameState.recognizedIds.add(userId);
            }
          }
          currentRawData.push({
            rawBox: box,
            rawCenter: center,
            label,
            boxColor,
            status,
            userId,
            faceHash,
            index: i,
            descriptor: detection.descriptor
          });
        }

        // --- 2. Emparejamiento, Suavizado (EMA) y Persistencia ---
        let nextSmoothedData = [];
        let matchedPreviousIndices = new Set();

        // --- 2a. Procesar detecciones actuales: emparejar con previas o considerar nuevas ---
        for (const currentData of currentRawData) {
          let bestMatchIndex = -1;
          let minDistance = MAX_MATCH_DISTANCE;

          for (let i = 0; i < previousSmoothedData.length; i++) {
            if (matchedPreviousIndices.has(i)) continue;
            const prevData = previousSmoothedData[i];
            const prevCenter = getBoxCenter(prevData.box);
            const distance = getDistance(currentData.rawCenter, prevCenter);

            if (distance < minDistance) {
              minDistance = distance;
              bestMatchIndex = i;
            }
          }

          if (bestMatchIndex !== -1) {
            const prevData = previousSmoothedData[bestMatchIndex];
            matchedPreviousIndices.add(bestMatchIndex);

            const smoothed = smoothBox(currentData.rawBox, prevData.box, SMOOTHING_ALPHA);

            nextSmoothedData.push({
              id: prevData.id,
              box: smoothed,
              label: currentData.label,
              color: currentData.boxColor,
              status: currentData.status,
              userId: currentData.userId,
              faceHash: currentData.faceHash,
              lastUpdateFrame: currentFrame,
              missingFrames: 0
            });
          } else {
            nextSmoothedData.push({
              id: nextFaceId++,
              box: currentData.rawBox,
              label: currentData.label,
              color: currentData.boxColor,
              status: currentData.status,
              userId: currentData.userId,
              faceHash: currentData.faceHash,
              lastUpdateFrame: currentFrame,
              missingFrames: 0
            });
          }
        }

        // --- 2b. Procesar caras suavizadas previas que NO fueron emparejadas (Persistencia) ---
        for (let i = 0; i < previousSmoothedData.length; i++) {
          if (!matchedPreviousIndices.has(i)) {
            const prevData = previousSmoothedData[i];
            const newMissingFrames = prevData.missingFrames + 1;

            if (newMissingFrames < MAX_MISSING_FRAMES) {
              nextSmoothedData.push({
                id: prevData.id,
                box: prevData.box,
                label: prevData.label,
                color: prevData.color,
                status: prevData.status,
                userId: prevData.userId,
                faceHash: prevData.faceHash,
                lastUpdateFrame: prevData.lastUpdateFrame,
                missingFrames: newMissingFrames
              });
            }
          }
        }

        // Actualizar previousSmoothedData para el siguiente frame
        previousSmoothedData = nextSmoothedData;

        // --- 3. Lógica de Estados Consecutivos y Mensajes ---
        const now = Date.now();

        // Resetear contadores si no hay caras detectadas en el frame actual
        if (!currentFrameState.hasFace) {
          consecutiveFramesState.noFace++;
          consecutiveFramesState.coveredFace = 0;
          consecutiveFramesState.unregisteredFace = 0;
          consecutiveFramesState.recognizedFaces = {};
        } else {
          consecutiveFramesState.noFace = 0;
          consecutiveFramesState.closingWarningShown = false;
        }

        // Contadores para estados específicos
        if (currentFrameState.hasFace) {
          if (currentFrameState.hasCovered) consecutiveFramesState.coveredFace++; else consecutiveFramesState.coveredFace = 0;
          if (currentFrameState.hasUnregistered) consecutiveFramesState.unregisteredFace++; else consecutiveFramesState.unregisteredFace = 0;

          const currentRecognized = consecutiveFramesState.recognizedFaces;
          consecutiveFramesState.recognizedFaces = {};
          currentFrameState.recognizedIds.forEach(id => {
            consecutiveFramesState.recognizedFaces[id] = (currentRecognized[id] || 0) + 1;
          });
        }

        // --- Disparar Acciones ---

        // Advertencia de inactividad / cierre
        if (consecutiveFramesState.noFace >= WARNING_NO_FACE_FRAMES && !consecutiveFramesState.closingWarningShown) {
          enqueueMessage('No se detecta actividad facial. Cerrando pronto...', 'warning', 10000, true);
          consecutiveFramesState.closingWarningShown = true;
        }
        if (consecutiveFramesState.noFace >= MAX_CONSECUTIVE_NO_FACE) {
          closeDetection('inactividad');
          return;
        }

        // "Descubrir Cara"
        if (consecutiveFramesState.coveredFace >= REQUIRED_CONSECUTIVE_FRAMES_COVERED) {
          if (now - lastMessageTime.uncoverFace > UNCOVER_FACE_COOLDOWN_MS) {
            enqueueMessage('Por favor, descubra su rostro.', 'warning', 5000, true);
            lastMessageTime.uncoverFace = now;
          }
        }

        // "Persona No Registrada" con Caché y Anuncio Único por Sesión
        if (consecutiveFramesState.unregisteredFace >= REQUIRED_CONSECUTIVE_FRAMES_UNREGISTERED) {
          let shouldAnnounceUnregistered = false;
          const currentUnknownHashes = currentFrameState.currentFrameUnknownHashes;

          for (const hash of currentUnknownHashes) {
            if (!hash) continue;

            if (!unregisteredCache.has(hash) && !announcedUnregisteredHashes.has(hash)) {
              unregisteredCache.add(hash);
              announcedUnregisteredHashes.add(hash);
              shouldAnnounceUnregistered = true;
              console.log(`New unregistered face detected and cached (Hash: ${hash.substring(0, 15)}...). Added to session announcements.`);
            }
          }

          if (shouldAnnounceUnregistered) {
            if (now - lastMessageTime.unregisteredAnnounce > UNREGISTERED_GENERAL_COOLDOWN_MS) {
              enqueueMessage('Persona no registrada detectada.', 'warning', 5000, true);
              lastMessageTime.unregisteredAnnounce = now;
            }
          }
        }

        // Saludos Únicos por Sesión y Detección de Manchas para Usuarios Reconocidos
        for (const userId in consecutiveFramesState.recognizedFaces) {
          if (consecutiveFramesState.recognizedFaces[userId] >= REQUIRED_CONSECUTIVE_FRAMES_GENERAL) {
            // Saludo único
            if (!greetedUserIds.has(userId)) {
              const faceData = previousSmoothedData.find(f => f.userId === userId);
              if (faceData) {
                const userName = faceData.label && faceData.label !== 'unknown' ? faceData.label : 'Usuario';
                enqueueMessage(`Hola, ${userName}! Bienvenido.`, 'success', 4000, true);
                greetedUserIds.add(userId);
                console.log(`User ${userId} (${userName}) greeted.`);
              }
            }

            // Detección de Manchas
            const referenceImages = await loadUserReferenceImages(userId);
            const faceData = previousSmoothedData.find(f => f.userId === userId);

            if (faceData && referenceImages.length > 0) {
              const hasMancha = await detectSkinToneDifference(video, faceData.box, referenceImages);

              if (hasMancha) {
                consecutiveFramesMancha++;
              } else {
                consecutiveFramesMancha = 0;
              }

              if (consecutiveFramesMancha >= REQUIRED_CONSECUTIVE_FRAMES_MANCHA) {
                if (now - lastManchaAnnounceTime > MANCHA_ANNOUNCE_COOLDOWN_MS) {
                  enqueueMessage('Mancha detectada en la piel.', 'warning', 5000, true);
                  lastManchaAnnounceTime = now;
                }
                consecutiveFramesMancha = 0;
              }
            }

            // Resetear contador de frames para este usuario
            consecutiveFramesState.recognizedFaces[userId] = 0;
          }
        }

        // --- 4. Dibujar Cuadros Suavizados ---
        previousSmoothedData.forEach(data => {
          const drawBox = new faceapi.draw.DrawBox(data.box, {
            label: data.label,
            lineWidth: 3,
            boxColor: data.color,
            drawLabelOptions: {fontColor: 'white', fontSize: 18, padding: 3, backgroundColor: data.color}
          });
          drawBox.draw(canvas);
        });

      } catch (error) {
        console.error('ERR in detection loop:', error);
        if (messageQueue.filter(m => m.text === 'Error en ciclo de detección.').length === 0) {
          enqueueMessage('Error en ciclo de detección.', 'error', 5000, false);
        }
      }
    }, detectionIntervalMs);
  }

  // --- Inicialización Principal ---
  async function main() {
    loadUnregisteredCache();
    const modelsAndDataLoaded = await loadModelsAndData();
    if (!modelsAndDataLoaded) return;
    const videoStarted = await startVideo();
    if (!videoStarted) return;

    if (faceMatcher && video.readyState >= 3 && stream && stream.active) {
      runDetection();
    } else {
      console.error("Failed to start detection: Matcher or video stream not ready.");
      enqueueMessage('No se pudo iniciar la detección facial.', 'error', 8000, true, true);
      closeDetection('inicio fallido');
    }
  }

  main();

  // --- Limpieza y Errores Adicionales ---
  window.addEventListener('beforeunload', () => {
    console.log("beforeunload event. Cleaning up.");
    closeDetection('cierre página');
    saveUnregisteredCache();
  });

  video.addEventListener('error', (e) => {
    console.error('Video element error:', e);
    closeDetection('error video');
  });

  if (synth) {
    synth.onerror = (event) => {
      console.error('Speech synthesis error:', event.error);
    };
  } else {
    console.warn('Speech synthesis not supported in this browser.');
  }
});

// --- Función showToast ---
function showToast(message, type = 'info', duration = 4000) {
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.position = 'fixed';
    toastContainer.style.bottom = '20px';
    toastContainer.style.left = '50%';
    toastContainer.style.transform = 'translateX(-50%)';
    toastContainer.style.zIndex = '2000';
    toastContainer.style.display = 'flex';
    toastContainer.style.flexDirection = 'column';
    toastContainer.style.alignItems = 'center';
    toastContainer.style.pointerEvents = 'none';
    document.body.appendChild(toastContainer);
  }
  const toastElement = document.createElement('div');
  toastElement.className = `toast toast-${type}`;
  toastElement.textContent = message;
  toastElement.style.padding = '12px 20px';
  toastElement.style.marginBottom = '10px';
  toastElement.style.borderRadius = '6px';
  toastElement.style.color = 'white';
  toastElement.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
  toastElement.style.opacity = '0';
  toastElement.style.transition = 'opacity 0.4s ease-in-out';
  toastElement.style.maxWidth = '90%';
  toastElement.style.textAlign = 'center';
  toastElement.style.wordBreak = 'break-word';
  toastElement.style.pointerEvents = 'auto';

  switch (type) {
    case 'success':
      toastElement.style.backgroundColor = 'rgba(40, 167, 69, 0.95)';
      break;
    case 'warning':
      toastElement.style.backgroundColor = 'rgba(255, 193, 7, 0.95)';
      toastElement.style.color = '#333';
      break;
    case 'error':
      toastElement.style.backgroundColor = 'rgba(220, 53, 69, 0.95)';
      break;
    default:
      toastElement.style.backgroundColor = 'rgba(0, 123, 255, 0.95)';
  }

  toastContainer.prepend(toastElement);

  setTimeout(() => {
    toastElement.style.opacity = '1';
  }, 50);

  const timerId = setTimeout(() => {
    if (toastElement && toastElement.parentNode) {
      toastElement.style.opacity = '0';
      setTimeout(() => {
        try {
          toastElement.remove();
        } catch (e) {
          console.error("Error removing toast after fade:", e);
        }
      }, 400);
    }
  }, duration);

  toastElement.addEventListener('click', () => {
    clearTimeout(timerId);
    if (toastElement && toastElement.parentNode) {
      toastElement.style.opacity = '0';
      setTimeout(() => {
        try {
          toastElement.remove();
        } catch (e) {
          console.error("Error removing toast after click:", e);
        }
      }, 400);
    }
  }, {once: true});

  return toastElement;
}
