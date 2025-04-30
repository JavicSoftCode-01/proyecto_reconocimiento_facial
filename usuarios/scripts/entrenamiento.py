import os

import joblib
import numpy as np
from django.conf import settings
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.svm import SVC
from tensorflow.keras.applications import MobileNetV2
from tensorflow.keras.applications.mobilenet_v2 import preprocess_input
from tensorflow.keras.preprocessing.image import load_img, img_to_array

# Directorio base donde están las imágenes
BASE_DIR = os.path.join(settings.MEDIA_ROOT, 'fotos_usuarios')

# Cargar MobileNetV2 preentrenada sin la capa superior
base_model = MobileNetV2(weights='imagenet', include_top=False, input_shape=(224, 224, 3))
base_model.trainable = False


def extract_features(img_path):
  """Extrae características faciales de una imagen usando MobileNetV2."""
  try:
    img = load_img(img_path, target_size=(224, 224))
    img_array = img_to_array(img)
    img_array = np.expand_dims(img_array, axis=0)
    img_array = preprocess_input(img_array)
    features = base_model.predict(img_array)
    return features.flatten()
  except Exception as e:
    print(f"Error al procesar {img_path}: {e}")
    return None


def cargar_datos():
  """Carga las imágenes y etiquetas de los usuarios."""
  X, y = [], []
  for user_dir in os.listdir(BASE_DIR):
    user_path = os.path.join(BASE_DIR, user_dir)
    if os.path.isdir(user_path) and user_dir.startswith('user_'):
      user_id = int(user_dir.split('_')[1])
      for img_file in os.listdir(user_path):
        img_path = os.path.join(user_path, img_file)
        features = extract_features(img_path)
        if features is not None:
          X.append(features)
          y.append(user_id)
  return np.array(X), np.array(y)


def entrenar_modelo():
  """Entrena el modelo de IA y lo guarda."""
  # Cargar datos
  X, y = cargar_datos()
  if len(X) == 0:
    print("No se encontraron datos para entrenar.")
    return

  # Dividir en entrenamiento y prueba
  X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

  # Entrenar clasificador SVM
  clf = SVC(kernel='linear', probability=True)
  clf.fit(X_train, y_train)

  # Evaluar
  y_pred = clf.predict(X_test)
  accuracy = accuracy_score(y_test, y_pred)
  print(f"Precisión del modelo: {accuracy:.2f}")

  # Guardar el modelo
  model_path = os.path.join(settings.BASE_DIR, 'modelos', 'face_recognition_model.pkl')
  os.makedirs(os.path.dirname(model_path), exist_ok=True)
  joblib.dump(clf, model_path)
  print(f"Modelo guardado en {model_path}")


if __name__ == "__main__":
  entrenar_modelo()
