# usuarios/urls.py
from django.urls import path

from . import views
from .views import (
  ListaUsuariosView, DetalleUsuarioView,
  EditarUsuarioView, EliminarUsuarioView,
  ReconocimientoFacialView, DeteccionTiempoRealView
)


urlpatterns = [
  path('', ListaUsuariosView.as_view(), name='lista_usuarios'),

  path('<int:pk>/', DetalleUsuarioView.as_view(), name='detalle_usuario'),

  path('editar/<int:pk>/', EditarUsuarioView.as_view(), name='editar_usuario'),

  path('eliminar/<int:pk>/', EliminarUsuarioView.as_view(), name='eliminar_usuario'),

  path('reconocimiento/', ReconocimientoFacialView.as_view(), name='reconocimiento_facial'),

  path('deteccion/', DeteccionTiempoRealView.as_view(), name='deteccion_tiempo_real'),

  # API endpoint to get registered users data
  path('api/users/', views.get_registered_users, name='api_get_registered_users'),
]
