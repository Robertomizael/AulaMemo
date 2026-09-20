# AulaMemo AI — GitHub Pages + Google Drive

## GitHub Pages
El workflow de `.github/workflows/pages.yml` publica la aplicación desde `main`.

En GitHub abre **Settings > Pages** y selecciona **GitHub Actions** como fuente.

## Google Drive
1. Abre Google Apps Script.
2. Crea un proyecto nuevo.
3. Copia `google-apps-script/Code.gs`.
4. Despliega como **Web app**.
5. Copia la URL terminada en `/exec`.
6. Pégala en `config.js` dentro de `appsScriptUrl`.

La versión actual guarda en Drive la ficha de sesión y sus notas. El audio se mantiene local hasta integrar Drive API/OAuth para cargas grandes.

## Seguridad
Nunca coloques claves privadas de IA en GitHub Pages o en `config.js`.