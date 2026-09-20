# AulaMemo AI

PWA académica para grabar clases y reuniones, añadir notas con marcas de tiempo, organizar sesiones y preparar transcripción, resumen, mapa mental y materiales de estudio.

**Autor:** Dr. Roberto Joel Tirado Reyes  
**Identidad visual:** azul y oro UAS.

## Publicación en GitHub Pages
1. Crear o usar este repositorio público.
2. Subir el contenido de la aplicación a la rama `main`.
3. Ir a `Settings > Pages` y seleccionar `GitHub Actions` como fuente.
4. El workflow incluido publicará la PWA automáticamente.

## Google Drive
El directorio `google-apps-script/` contiene el puente inicial para guardar notas y metadatos de cada sesión en Drive. La URL `/exec` del despliegue se pega en `config.js`.

## Seguridad
No colocar claves privadas de IA en GitHub Pages ni en `config.js`. La transcripción y el procesamiento de IA deben conectarse mediante un backend seguro.
