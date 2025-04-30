# reconocimiento_facial/urls.py
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import path, include
from django.views.generic.base import RedirectView

urlpatterns = [

  path('admin/', admin.site.urls),

  path('usuarios/', include('usuarios.urls')),

  path('', RedirectView.as_view(pattern_name='lista_usuarios', permanent=False), name='home_redirect'),
]

# El manejo de archivos media/static en desarrollo se mantiene aquí
if settings.DEBUG:
  urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
