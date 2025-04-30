# usuarios/views.py
import base64
import json
import os
import uuid
from django.views.decorators.csrf import csrf_exempt  # Necesario para la API
from django.conf import settings
from django.contrib import messages
from django.core.files.base import ContentFile
from django.http import JsonResponse
from django.urls import reverse_lazy
from django.views.generic import CreateView
from django.views.generic import ListView, DetailView, UpdateView, DeleteView, TemplateView

from .forms import UsuarioForm
from .models import Usuario




# Cargar el modelo Keras al iniciar el servidor
try:
    skin_disease_model = load_model('/static/js/Modelo_IA_Entrenada.keras')
    print("Modelo Keras cargado exitosamente al iniciar el servidor.")
except Exception as e:
    skin_disease_model = None
    print(f"Error al cargar el modelo Keras: {e}")

@csrf_exempt  # Permitir solicitudes POST desde JavaScript sin CSRF (ajusta en producción)
def predict_skin_disease(request):
    if request.method == 'POST':
        if skin_disease_model is None:
            return JsonResponse({'error': 'Modelo no cargado en el servidor'}, status=500)

        try:
            # Obtener la imagen en base64 desde el request
            data = json.loads(request.body)
            img_data = data['image'].split(',')[1]  # Eliminar prefijo 'data:image/jpeg;base64,'
            img_bytes = base64.b64decode(img_data)
            img = Image.open(BytesIO(img_bytes))
            img = img.resize((224, 224))  # Ajustar al tamaño esperado por tu modelo
            img_array = np.array(img) / 255.0  # Normalizar (ajústalo según tu modelo)
            img_array = np.expand_dims(img_array, axis=0)  # Añadir dimensión de batch

            # Realizar la predicción
            prediction = skin_disease_model.predict(img_array)
            class_index = np.argmax(prediction, axis=1)[0]
            confidence = prediction[0][class_index]
            classes = ['MEL', 'NV', 'BCC', 'AK', 'BKL', 'DF', 'VASC', 'SCC']  # Ajusta según tu modelo

            # Umbral de confianza
            if confidence > 0.7 and class_index < len(classes):
                disease = classes[class_index]
                return JsonResponse({
                    'disease': disease,
                    'confidence': float(confidence)
                })
            else:
                return JsonResponse({
                    'disease': None,
                    'confidence': 0.0,
                    'message': 'No se detectó enfermedad con suficiente confianza'
                })
        except Exception as e:
            return JsonResponse({'error': f'Error al procesar la imagen: {str(e)}'}, status=400)
    return JsonResponse({'error': 'Método no permitido'}, status=405)

class ListaUsuariosView(ListView):
  model = Usuario
  template_name = 'usuarios/templates/lista_usuarios.html'
  context_object_name = 'usuarios'


class DetalleUsuarioView(DetailView):
  model = Usuario
  template_name = 'usuarios/templates/detalle_usuario.html'


class EditarUsuarioView(UpdateView):
  model = Usuario
  form_class = UsuarioForm
  template_name = 'usuarios/templates/editar_usuario.html'
  success_url = reverse_lazy('lista_usuarios')


class EliminarUsuarioView(DeleteView):
  model = Usuario
  template_name = 'usuarios/templates/eliminar_usuario.html'
  success_url = reverse_lazy('lista_usuarios')


class ReconocimientoFacialView(CreateView):
  model = Usuario
  form_class = UsuarioForm
  template_name = 'usuarios/templates/reconocimiento_facial.html'
  success_url = reverse_lazy('lista_usuarios')

  def form_valid(self, form):
    # Obtener datos del formulario
    foto_data = self.request.POST.get('foto_data', '')  # Single representative photo data URL
    descriptors = self.request.POST.get('descriptors', '[]')  # Descriptors JSON string
    captured_photos_data = self.request.POST.get('captured_photos_data', '[]')  # NEW: Array of 10 photo data URLs

    # --- Process the single representative photo for the Usuario model ---
    if foto_data and foto_data.startswith('data:image/jpeg;base64,'):
      try:
        # Extract base64 data
        formato, imgstr = foto_data.split(';base64,')
        data = ContentFile(base64.b64decode(imgstr))

        # Create unique filename for the main photo
        nombre = form.cleaned_data['nombre_completo']
        # Using a more robust slug or ID later is better, but for now, use name + uuid
        filename = f"{nombre.replace(' ', '_').lower()}_{uuid.uuid4().hex[:8]}.jpg"

        # Save the main image to the 'foto' field
        form.instance.foto.save(filename, data, save=False)  # Save=False initially

      except Exception as e:
        messages.error(self.request, f"Error al procesar la imagen principal: {str(e)}")
        # Return invalid form if main photo processing fails
        return super().form_invalid(form)
    else:
      messages.warning(self.request, "No se proporcionó una imagen principal válida")
      pass

    # --- Process the facial descriptors ---
    try:
      descriptors_json = json.loads(descriptors)
      form.instance.descriptores_faciales = json.dumps(descriptors_json)
    except json.JSONDecodeError:
      messages.warning(self.request, "Error al procesar los descriptores faciales")
      form.instance.descriptores_faciales = None  # Ensure it's not set if invalid JSON

    # --- Save the Usuario object to get an ID ---
    response = super().form_valid(form)

    # --- Process and save the 10 captured photos ---
    if hasattr(self, 'object') and self.object:
      try:
        captured_photos_list = json.loads(captured_photos_data)

        if captured_photos_list:
          user_photos_dir = os.path.join(settings.MEDIA_ROOT, 'fotos_usuarios', f'user_{self.object.id}')
          os.makedirs(user_photos_dir, exist_ok=True)

          # Save each captured photo data URL as a separate file
          for i, photo_data_url in enumerate(captured_photos_list):
            if photo_data_url and photo_data_url.startswith('data:image/jpeg;base64,'):
              try:
                formato, imgstr_single = photo_data_url.split(';base64,')
                img_data_single = base64.b64decode(imgstr_single)
                photo_path = os.path.join(user_photos_dir, f'rostro_{i + 1}.jpg')  # Use i+1 for 1-based naming

                # Save the image file
                with open(photo_path, 'wb') as f:
                  f.write(img_data_single)

              except Exception as e:
                messages.warning(self.request, f"Error al guardar la foto capturada {i + 1}: {str(e)}")
            else:
              messages.warning(self.request, f"Datos de foto capturada {i + 1} inválidos")

      except json.JSONDecodeError:
        messages.warning(self.request, "Error al procesar los datos de las fotos capturadas")
      except Exception as e:
        messages.warning(self.request, f"Error general al guardar las fotos capturadas: {str(e)}")

    messages.success(self.request, f"Usuario {nombre} registrado correctamente con reconocimiento facial")
    return response

  def form_invalid(self, form):
    messages.error(self.request, "Por favor corrija los errores en el formulario")
    return super().form_invalid(form)


class DeteccionTiempoRealView(TemplateView):
  template_name = 'usuarios/templates/deteccion_en_tiempo_real.html'


def get_registered_users(request):
  # Excluir usuarios sin descriptores o con listas vacías
  users = Usuario.objects \
    .exclude(descriptores_faciales__isnull=True) \
    .exclude(descriptores_faciales__exact=[])

  users_data = []
  for user in users:
    try:
      raw = user.descriptores_faciales

      # Fallback mínimo para cadenas JSON legadas
      if isinstance(raw, str):
        raw = json.loads(raw)

      # Validación: debe ser lista de listas de longitud 128 con números
      if (
        isinstance(raw, list)
        and all(isinstance(d, list) and len(d) == 128 and all(isinstance(v, (int, float)) for v in d)
                for d in raw
                )):
        users_data.append({
          'id': user.id,
          'nombre_completo': user.nombre_completo,
          'descriptores': raw
        })
      else:
        print(
          f"Warning: Formato inesperado de descriptores para el usuario {user.id} ({user.nombre_completo})"
        )
    except json.JSONDecodeError:
      print(
        f"Warning: No se pudo decodificar JSON de descriptores para el usuario {user.id} ({user.nombre_completo})"
      )
    except Exception as e:
      print(
        f"Error: Al procesar descriptores del usuario {user.id} ({user.nombre_completo}): {e}"
      )

  # safe=False porque devolvemos una lista, no un diccionario
  return JsonResponse(users_data, safe=False)
