# usuarios/models.py
from django.db import models


class Usuario(models.Model):
  nombre_completo = models.CharField(max_length=100)
  foto = models.ImageField(upload_to='fotos_usuarios/')
  descriptores_faciales = models.JSONField(blank=True, null=True)
  fecha_registro = models.DateTimeField(auto_now_add=True)

  def __str__(self):
    return self.nombre_completo

  class Meta:
    verbose_name = "Usuario"
    verbose_name_plural = "Usuarios"
