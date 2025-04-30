# usuarios/forms.py
from django import forms

from .models import Usuario


class UsuarioForm(forms.ModelForm):
  class Meta:
    model = Usuario
    fields = ['nombre_completo', 'foto']
    widgets = {
      'nombre_completo': forms.TextInput(attrs={'class': 'form-control', 'required': 'required'}),
      'foto': forms.FileInput(attrs={'class': 'form-control-file', 'style': 'display:none;'}),
    }

  def __init__(self, *args, **kwargs):
    super().__init__(*args, **kwargs)
    # Hacer que el campo foto sea opcional
    self.fields['foto'].required = False
