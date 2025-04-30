import base64
import json
import os

from django.conf import settings


def procesar_capturas(captured_photos_data, user_id):
  """
  Procesa las imágenes capturadas enviadas desde el frontend y las guarda en el directorio del usuario.
  Args:
      captured_photos_data (str): JSON con las URLs de datos de las imágenes capturadas.
      user_id (int): ID del usuario para crear su carpeta.
  """
  # Directorio donde se guardarán las fotos del usuario
  user_dir = os.path.join(settings.MEDIA_ROOT, 'fotos_usuarios', f'user_{user_id}')
  os.makedirs(user_dir, exist_ok=True)

  # Decodificar el JSON con las imágenes
  try:
    photos_list = json.loads(captured_photos_data)
  except json.JSONDecodeError:
    print("Error al decodificar los datos de las fotos capturadas")
    return

  # Procesar cada imagen
  for i, photo_data in enumerate(photos_list):
    if photo_data.startswith('data:image/jpeg;base64,'):
      try:
        # Extraer los datos base64
        _, imgstr = photo_data.split(';base64,')
        img_data = base64.b64decode(imgstr)

        # Guardar la imagen
        photo_path = os.path.join(user_dir, f'rostro_{i + 1}.jpg')
        with open(photo_path, 'wb') as f:
          f.write(img_data)
        print(f"Guardada imagen {i + 1} en {photo_path}")
      except Exception as e:
        print(f"Error al procesar la imagen {i + 1}: {e}")
    else:
      print(f"Datos de imagen {i + 1} inválidos")


# Ejemplo de uso (esto se integrará en tu vista Django)
if __name__ == "__main__":
  # Simulación de datos recibidos del frontend
  sample_data = '["data:image/jpeg;base64,/9j/4AAQSkZJRg..."]'  # Reemplaza con datos reales
  procesar_capturas(sample_data, user_id=1)
