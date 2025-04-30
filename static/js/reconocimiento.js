// static/js/reconocimiento.js
document.addEventListener('DOMContentLoaded', function () {
  const reconocerBtn = document.getElementById('reconocerBtn');
  // UI Elements
  const videoContainer = document.getElementById('videoContainer');
  const cameraArea = document.getElementById('cameraArea');
  const videoWrapper = document.getElementById('videoWrapper');
  const placeholderImage = document.getElementById('placeholderImage');
  const video = document.getElementById('video');
  const mensaje = document.getElementById('mensaje');
  const progressRingBase = document.getElementById('progressRingBase');
  const progressRing = document.getElementById('progressRing');
  // Form Elements
  const form = document.getElementById('reconocimiento_form');
  const descriptorsInput = document.getElementById('descriptorsInput');
  const fotoDataInput = document.getElementById('fotoDataInput');
  const capturedPhotosDataInput = document.getElementById('capturedPhotosDataInput');
  const nombreInput = document.querySelector('input[name="nombre_completo"]');


  // State Variables
  let isSubmitting = false; // Flag to prevent double submission
  let stream = null; // Variable para guardar el stream de la cámara
  let captureIntervalId = null; // ID para el intervalo de captura
  let capturedDescriptors = []; // Array para almacenar los descriptores
  let capturedPhotosDataUrls = []; // Array para almacenar los data URLs de las fotos
  let currentDisplayedMessage = ""; // Variable para rastrear el mensaje actual y evitar flickering
  let captureCanvas = null; // Canvas persistente para la captura

  // Capture Configuration
  const maxCaptures = 100; // Number of images to capture for training
  const captureIntervalMs = 300; // How often to check for faces (ms)
  const minCaptureTimeMs = 800; // Minimum time between *successful* captures (ms) to avoid duplicates from same pose
  let lastSuccessfulCaptureTime = 0; // Timestamp of the last successful capture

  // No Face Detection Handling
  let framesWithoutFace = 0; // Counter for consecutive frames without detection
  // Tolerancia: cuántos frames sin cara antes de mostrar un mensaje de "buscando"
  const noFaceMessageDelayFrames = Math.ceil(1500 / captureIntervalMs); // e.g., show seeking message after 1.5 seconds of no face
  // Tolerancia: cuántos frames sin cara antes de cancelar la captura
  const noFaceTimeoutFrames = Math.ceil(5000 / captureIntervalMs); // e.g., cancel after 5 seconds of no face

  // Pose Guidance Messages (more concise)
  const poseMessages = [
    "Mira al frente",
    "Inclina a la izquierda",
    "Gira a la derecha",
    "Inclina hacia arriba",
    "Inclina hacia abajo",
    "Gira a la izquierda", // Added rotation variations
    "Gira a la derecha",
    "Inclinación lateral izq.", // Added tilt variations
    "Inclinación lateral der."
  ];

  // Determine message text based on capture count
  function getGuidanceMessage(count) {
    if (count >= maxCaptures) return "Completa"; // Should not happen while capturing, but safe
    const step = Math.max(1, Math.floor(maxCaptures / poseMessages.length)); // Ensure step is at least 1
    const messageIndex = Math.min(Math.floor(count / step), poseMessages.length - 1);
    return `${poseMessages[messageIndex]}`;
  }

  // Function to update the message text and circular progress
  // progress: -1 (hide rings), 0-100 (show rings and update variable)
  function updateUI(text, progress = -1) {
    // Only update message text if it's different from the current one
    if (mensaje.textContent !== text) {
      mensaje.textContent = text;
      currentDisplayedMessage = text; // Update our tracker
      console.log("UI Message Updated:", text); // Log message changes
    }

    if (progress >= 0 && progress <= 100) {
      progressRingBase.style.display = 'block';
      progressRing.style.display = 'block';
      // Clamp progress between 0 and 100
      const clampedProgress = Math.max(0, Math.min(100, progress));
      // Update the CSS variable for the conic-gradient animation
      progressRing.style.setProperty('--progress', clampedProgress);
    } else {
      // Hide rings and reset variable if progress < 0
      progressRingBase.style.display = 'none';
      progressRing.style.display = 'none';
      progressRing.style.setProperty('--progress', 0); // Reset variable
    }
  }

  // Function to stop the camera stream
  function stopCamera() {
    if (stream) {
      console.log("Stopping camera stream.");
      stream.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      stream = null;
      console.log("Camera stream stopped.");
    }
  }

  // Function to stop the capture interval
  function stopCaptureInterval() {
    if (captureIntervalId !== null) {
      console.log("Stopping capture interval.");
      clearInterval(captureIntervalId);
      captureIntervalId = null;
      console.log("Capture interval stopped.");
    }
  }

  // --- Function to reset UI and state after completion or error ---
  function resetCaptureProcess() {
    console.log("Resetting capture process.");
    stopCaptureInterval();
    stopCamera();

    // Clean up the persistent canvas if it exists
    if (captureCanvas) {
      captureCanvas.remove();
      captureCanvas = null;
      console.log("Persistent canvas removed.");
    }

    isSubmitting = false; // Reset flag
    reconocerBtn.disabled = false; // Re-enable button
    placeholderImage.style.display = 'block'; // Show placeholder
    video.style.display = 'none';           // Hide video

    // Reset data arrays
    capturedDescriptors = [];
    capturedPhotosDataUrls = [];
    lastSuccessfulCaptureTime = 0;
    framesWithoutFace = 0; // Reset no face counter

    // Reset UI messages and progress
    updateUI('Presione "Capturar Rostros" para iniciar.');
    updateUI('', -1); // Ensure progress rings are hidden

    console.log("Capture process reset complete.");
  }


  // --- Event Listener for the "Capturar Rostros" button ---
  reconocerBtn.addEventListener('click', async () => {
    if (isSubmitting) {
      console.log("Submission in progress, ignoring click.");
      return; // Prevent multiple clicks while submitting
    }

    // Validate Name field
    if (!nombreInput.value.trim()) {
      showToast('Por favor, complete el campo de nombre antes de iniciar la captura.', 'warning');
      nombreInput.focus(); // Focus on the input field
      return;
    }

    // Deshabilitar botón e iniciar proceso
    reconocerBtn.disabled = true;
    isSubmitting = false; // Ensure flag is false at start

    // Reset state for a new session
    capturedDescriptors = [];
    capturedPhotosDataUrls = [];
    lastSuccessfulCaptureTime = 0;
    framesWithoutFace = 0; // Reset counter


    // Initial UI update: loading models, show progress 0
    updateUI('Iniciando: Cargando modelos...', 0);

    // Hide placeholder and show video element area (video content not ready yet)
    placeholderImage.style.display = 'none';
    video.style.display = 'block';
    console.log("Switched from placeholder to video element.");

    // Create persistent canvas if it doesn't exist
    if (!captureCanvas) {
      captureCanvas = document.createElement('canvas');
      captureCanvas.style.display = 'none'; // Keep it hidden
      document.body.appendChild(captureCanvas); // Append to body
      console.log("Persistent canvas created.");
    }


    // Load face-api.js models *before* starting camera feed processing
    try {
      console.log("Loading face-api models.");
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri('/static/face-api/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/static/face-api/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/static/face-api/models')
      ]);
      console.log("Models loaded successfully.");
      showToast('Modelos de IA cargados.', 'info');
      // Models loaded, now try starting camera

    } catch (err) {
      console.error('Error al cargar los modelos:', err);
      showToast('Error al cargar los modelos de reconocimiento. Revise la consola.', 'error');
      updateUI('Error al cargar modelos. Presione "Capturar Rostros" para reintentar.');
      resetCaptureProcess(); // Clean up and reset UI
      return;
    }

    // Start camera stream *after* models are loaded
    try {
      updateUI('Modelos listos. Accediendo a la cámara...', 0); // Keep progress ring active
      console.log("Requesting camera access.");
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'user'} // Prefer front camera
      });
      video.srcObject = stream;

      // Wait for video to load and play
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => {
          console.log("Video metadata loaded.");
          video.play().then(() => {
            console.log("Video playback started.");
            resolve();
          }).catch(err => {
            console.error("Error playing video:", err);
            reject(err); // Reject promise on playback error
          });
        };
        video.onerror = (err) => {
          console.error("Video element error:", err);
          reject(new Error("Video element error: " + (err.message || 'Unknown error'))); // Reject promise on video element error
        };
      });

      showToast('Cámara iniciada. Buscando rostro...', 'info');
      // Camera ready, start the capture loop after a short delay for stream stabilization
      updateUI(`Cámara lista. Buscando rostro...`, 0); // Initial capture phase message
      setTimeout(startCaptureProcess, 500); // Delay start of capture loop

    } catch (err) {
      console.error('Error al acceder a la cámara:', err);
      updateUI('Error al acceder a la cámara.');
      showToast('Error al acceder a la cámara. Asegúrese de permitir el acceso.', 'error');
      resetCaptureProcess(); // Clean up and reset UI
      return;
    }
  });

  // --- Main capture process loop after models and camera are ready ---
  function startCaptureProcess() {
    console.log("Starting capture interval loop.");

    // Clear any existing interval before starting a new one
    stopCaptureInterval();

    captureIntervalId = setInterval(async () => {
      try {
        // Check video readiness again (should be ready)
        if (video.readyState !== 4) {
          const waitingMessage = 'Esperando stream de cámara...';
          if (currentDisplayedMessage !== waitingMessage) { // Avoid rapid updates
            updateUI(waitingMessage, Math.floor((capturedDescriptors.length / maxCaptures) * 100));
          }
          return; // Skip frame processing
        }

        // Update canvas dimensions to match video feed if needed
        if (captureCanvas.width !== video.videoWidth || captureCanvas.height !== video.videoHeight) {
          captureCanvas.width = video.videoWidth;
          captureCanvas.height = video.videoHeight;
          // console.log(`Canvas resized to ${captureCanvas.width}x${captureCanvas.height}`); // Log less often
        }
        const context = captureCanvas.getContext('2d');
        // Draw the current video frame onto the canvas
        context.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

        // --- Perform face detection and processing ---
        // Use ssdMobilenetv1Options for potentially faster/more accurate detection
        const detectionOptions = new faceapi.SsdMobilenetv1Options({minConfidence: 0.5}); // Adjust confidence if needed
        const detections = await faceapi.detectSingleFace(captureCanvas, detectionOptions)
          .withFaceLandmarks()
          .withFaceDescriptor();

        const now = Date.now();
        const currentProgress = Math.floor((capturedDescriptors.length / maxCaptures) * 100);

        if (detections) {
          framesWithoutFace = 0; // Reset counter if face is detected

          // Calculate time since last successful capture
          const timeSinceLastCapture = now - lastSuccessfulCaptureTime;

          // Check if we need more captures AND enough time has passed since the last one
          if (capturedDescriptors.length < maxCaptures && (timeSinceLastCapture >= minCaptureTimeMs || capturedDescriptors.length === 0)) {
            // Ready to capture a new frame (or it's the very first frame)
            lastSuccessfulCaptureTime = now; // Update time on successful capture

            // Capture the descriptor and photo data
            capturedDescriptors.push(Array.from(detections.descriptor));
            // Use a reasonable quality (0.9 is good balance)
            const photoDataUrl = captureCanvas.toDataURL('image/jpeg', 0.9);
            capturedPhotosDataUrls.push(photoDataUrl);

            // Determine the message for the *next* pose guidance (using updated count)
            const nextGuidance = getGuidanceMessage(capturedDescriptors.length);
            const nextMessage = `(${capturedDescriptors.length}/${maxCaptures}) ${nextGuidance}...`;

            // Update UI state for successful capture
            updateUI(nextMessage, currentProgress); // updateUI handles text change check internally
            console.log(`Captured ${capturedDescriptors.length}/${maxCaptures}. Progress: ${currentProgress}%`);


            // Check if max captures reached immediately after pushing
            if (capturedDescriptors.length >= maxCaptures) {
              console.log("Max captures reached.");
              // Add a small delay to show 100% progress before completing
              updateUI("Captura completa. Preparando para guardar...", 100);
              setTimeout(() => {
                completarCaptura(false); // Finish the process
              }, 500); // Short delay before submitting
              return; // Exit interval tick processing early
            }

          } else {
            // Face detected, but waiting for min time interval or already have enough
            // Keep the current message and progress ring, only update progress if it changed (unlikely here)
            const currentGuidance = getGuidanceMessage(capturedDescriptors.length);
            const currentCountMessage = `(${capturedDescriptors.length}/${maxCaptures}) ${currentGuidance}...`;
            updateUI(currentCountMessage, currentProgress); // Ensures message is the count/guidance if face is back
          }

        } else {
          // --- Handle no face detected ---
          framesWithoutFace++; // Increment counter

          const currentProgress = Math.floor((capturedDescriptors.length / maxCaptures) * 100);

          if (framesWithoutFace >= noFaceTimeoutFrames) {
            // Prolonged no face - cancel process
            console.log(`No face detected for ${framesWithoutFace} frames. Timeout reached. Stopping capture.`);
            showToast("No se detectó rostro por mucho tiempo. Captura cancelada.", 'warning');
            updateUI("Captura cancelada: Rostro no detectado.", currentProgress); // Final message before reset
            setTimeout(() => {
              resetCaptureProcess(); // Stop the process
            }, 1000); // Short delay before reset
            return; // Exit interval tick
          } else if (framesWithoutFace >= noFaceMessageDelayFrames) {
            // Show seeking message after a delay, only if not already showing a similar message
            const seekingMessage = `Buscando rostro... (${capturedDescriptors.length}/${maxCaptures})`;
            if (!currentDisplayedMessage.includes("Buscando rostro") && !currentDisplayedMessage.includes("Ajuste su posición")) {
              updateUI(seekingMessage, currentProgress); // Keep existing progress, update message
            } else {
              // Message is already the seeking one, just ensure progress ring is updated
              updateUI(currentDisplayedMessage, currentProgress);
            }
          } else {
            // Transient no face (less than delay threshold). Do not change message.
            // Keep the last message displayed (likely the pose guidance) and update progress ring.
            // No need to explicitly call updateUI here if the message hasn't changed,
            // but ensuring progress is updated might require it. Let's keep it simple:
            // If no face and within tolerance, the message stays whatever it was, progress updates.
            // updateUI(currentDisplayedMessage, currentProgress); // Optional: forces progress update even if message same
          }
          // TODO: Implement the "DESCUBRASE LA CARA" logic in the *detection* script (`deteccion.js`).
        }

      } catch (err) {
        console.error('Error en la detección facial durante la captura:', err);
        // Stop immediately on critical detection error inside the loop
        // Show a toast and update message, then complete with error flag
        const errorMessage = 'Error durante la captura. Intente de nuevo.';
        showToast(errorMessage, 'error');
        updateUI(errorMessage, Math.floor((capturedDescriptors.length / maxCaptures) * 100)); // Show error message
        setTimeout(() => {
          completarCaptura(true); // Finish the process with error flag
        }, 500); // Short delay before completing
        return; // Exit interval tick
      }
    }, captureIntervalMs); // Check loop runs every X ms
  }


  // --- Function to finalize the capture (success or error) ---
  // Handles cleanup, data preparation, and form submission
  function completarCaptura(error = false) {
    console.log("Completing capture process. Error:", error);
    stopCaptureInterval(); // Stop the interval immediately
    stopCamera(); // Stop the camera stream

    // Clean up the persistent canvas
    if (captureCanvas) {
      captureCanvas.remove();
      captureCanvas = null;
      console.log("Persistent canvas removed.");
    }

    isSubmitting = true; // Set submitting flag

    // Hide video and show placeholder after capture/error
    video.style.display = 'none';
    placeholderImage.style.display = 'block';
    console.log("Switched from video back to placeholder.");

    // Determine final progress state for UI update
    const finalProgress = error || capturedDescriptors.length === 0 ? -1 : 100;


    if (!error && capturedDescriptors.length > 0) {
      // Use the first captured frame as the main photo for the user record
      // This one will be saved directly to the Usuario model's 'foto' field
      const mainPhotoData = capturedPhotosDataUrls.length > 0 ? capturedPhotosDataUrls[0] : '';

      // Store descriptors and photo data in hidden input fields
      descriptorsInput.value = JSON.stringify(capturedDescriptors);
      fotoDataInput.value = mainPhotoData; // Single photo data URL for the main record field
      capturedPhotosDataInput.value = JSON.stringify(capturedPhotosDataUrls); // Array of ALL captured photo data URLs

      // Set final success message before submitting
      updateUI(`Captura completa (${capturedDescriptors.length}/${maxCaptures}). Enviando datos...`, finalProgress);
      showToast('Captura completada. Guardando usuario...', 'success');

      console.log("Submitting form.");
      // Submit the form automatically after a brief delay
      setTimeout(() => {
        form.submit();
      }, 1500); // Give UI a moment to update and show toast

    } else if (error) {
      // Error occurred during the process (e.g., detection failed repeatedly, critical error)
      // Message already set by the interval loop before calling completarCaptura(true)
      // Or set a general error message here if not set before
      if (!currentDisplayedMessage.includes("cancelada") && !currentDisplayedMessage.includes("error")) {
        updateUI('Captura cancelada debido a un error interno.');
      }
      // showToast is likely already called from where error was detected
      resetCaptureProcess(); // Reset fully on error

    } else { // No error, but no descriptors captured (e.g., camera ok, models ok, but face never detected)
      // Message should indicate no face was captured
      updateUI('No se pudo capturar ningún rostro. Intente de nuevo.', finalProgress);
      showToast('No se detectó ningún rostro durante la captura. Asegúrese de estar bien encuadrado y mirando a la cámara.', 'warning');
      resetCaptureProcess(); // Reset fully if no faces captured
    }
    // isSubmitting flag remains true if submitting form, reset by page load/navigation
    // If not submitting, it's reset in resetCaptureProcess
  }


  // --- Handle Django messages (Optional) ---
  // This processes messages rendered by Django backend
  const djangoMessagesDiv = document.querySelector('.messages');
  if (djangoMessagesDiv) {
    // Delay showing backend toasts slightly to avoid cluttering initial load messages
    setTimeout(() => {
      djangoMessagesDiv.querySelectorAll('.alert').forEach(alertElement => {
        const message = alertElement.textContent.trim();
        let type = 'info';
        if (alertElement.classList.contains('alert-success')) type = 'success';
        if (alertElement.classList.contains('alert-danger')) type = 'error';
        if (alertElement.classList.contains('alert-warning')) type = 'warning';
        // Use a different duration or style for backend messages if desired
        showToast(message, type, 8000); // Show backend messages as toasts
        alertElement.style.display = 'none'; // Hide the original Django message div
      });
    }, 500); // Small delay
  }

  // --- Cleanup on page navigation or close ---
  window.addEventListener('beforeunload', () => {
    console.log('Page unloading. Stopping camera stream, interval, and cleaning up.');
    stopCamera();
    stopCaptureInterval();
    // Clean up the persistent canvas
    if (captureCanvas) {
      captureCanvas.remove();
      captureCanvas = null;
    }
  });

  // --- Handle video playback errors ---
  video.addEventListener('error', (event) => {
    console.error('Video playback error:', event);
    let errorMessage = 'Error desconocido';
    if (event.target && event.target.error) {
      errorMessage = `Video error: Code ${event.target.error.code} - ${event.target.error.message}`;
      console.error(errorMessage);
    }
    showToast('Error en la reproducción de video de la cámara. Intente de nuevo.', 'error');
    updateUI('Error en la cámara. Presione "Capturar Rostros" para reintentar.');
    resetCaptureProcess(); // Reset fully on video error
  });
});