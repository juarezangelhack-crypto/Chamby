# Chambly

Chambly conecta a personas que buscan trabajo con oportunidades en Lima. La plataforma separa dos experiencias: **Trabajo rápido** y **Trabajo formal**, con perfiles independientes para cada modalidad.

**ODS relacionado:** [ODS 8, Trabajo decente y crecimiento económico](https://sdgs.un.org/goals/goal8). Es el marco al que se alinea el proyecto; no significa que la plataforma mida por sí sola el cumplimiento del objetivo.

- Sitio: <https://chamby-production.up.railway.app/>
- Repositorio público: <https://github.com/juarezangelhack-crypto/Chamby>

## Qué permite hacer

- Crear una cuenta e iniciar sesión con Firebase Authentication.
- Elegir una modalidad y mantener un perfil separado con distrito, foto y CV PDF; la foto de trabajo rápido también aparece en la bienvenida.
- Explorar oportunidades, filtrar por categoría y distrito, y postularse. El filtro de distrito comienza con el distrito del perfil y permite elegir otro o ver todos.
- Mostrar un avatar circular predeterminado cuando todavía no se ha agregado una foto de perfil.
- Publicar trabajos rápidos con un límite configurable de 1 a 10 postulantes.
- Ocultar del buscador los anuncios que alcanzan su límite, sin quitarlos de la administración del anunciante.
- Revisar postulantes, ver su perfil, abrir el chat o retirar una postulación.
- Conversar en tiempo real mediante Server-Sent Events.
- Explorar trabajos formales; la publicación de vacantes formales está deshabilitada por ahora.

## Flujo principal para la demostración

La regla 80/20 pide demostrar **un solo flujo de principio a fin**, en vez de recorrer todas las funciones.

1. Abrir la portada y escoger **Trabajo rápido**.
2. Entrar con una cuenta de prueba y mostrar el perfil con distrito de Villa El Salvador.
3. Como postulante, abrir una oportunidad claramente identificada como demostración y postularse.
4. Cambiar a la cuenta de prueba del anunciante, revisar la postulación, abrir el perfil y enviar un mensaje.

Antes de exponer, prepara dos cuentas de prueba y una publicación rotulada como **DEMO — no es una oferta real**. No presentes una publicación ficticia como vacante vigente. La ruta formal puede mencionarse brevemente, pero no forma parte del flujo principal de 90 segundos.

Usa cuentas y archivos de prueba. No subas datos personales ni CV reales durante una presentación pública.

## Reglas y criterios de la presentación

- Cierre de cambios de equipo: **10:00 a. m.**
- Regla 80/20: un flujo principal completo, probado y estable.
- Demostración en vivo del producto; no depender de una plantilla, video o capturas como sustituto de la aplicación.
- Pitch de 3 minutos: 45 s problema en VES y solución, 90 s demo y 45 s impacto ODS y escalabilidad.
- Rúbrica: impacto social (ODS) 30 %, ejecución técnica 30 %, innovación 25 % y presentación 15 %.

El proyecto tiene código propio en HTML, CSS, JavaScript y Python y está publicado en vivo. Si “código 100 % en vivo” significa programar frente al jurado y no solo ejecutar la aplicación, confirma esa interpretación con la organización: el código ya está desarrollado y no se debe afirmar que se escribió durante la presentación.

## Datos de Villa El Salvador (VES)

La aplicación permite indicar **Villa El Salvador** como distrito para perfiles y anuncios, pero no importa vacantes de otros portales. La búsqueda de fuentes públicas encontró estos puntos de consulta:

- [Sistemas de consulta del INEI](https://www.gob.pe/23456-sistemas-de-consultas-del-inei): enlaza SIRTOD, que ofrece indicadores demográficos, sociales y económicos a nivel distrital, entre otros niveles.
- [Censos Nacionales 2017 — Redatam](https://www.gob.pe/24120-consulta-la-base-de-datos-de-los-censos-nacionales-2017): permite consultar y descargar tablas censales con desgloses geográficos. Sirve para contextualizar VES, no para contar vacantes actuales.
- [Empleos Perú del MTPE](https://www.empleosperu.gob.pe/portal-mtpe/): portal público para consultar y postular a oportunidades laborales.

**Transparencia:** a 23 de noviembre de 2026 no se identificó un conjunto abierto, verificable y reutilizable de vacantes vigentes específicamente para VES. Por eso no se copiaron ni inventaron anuncios. Las ofertas que aparecen en Chambly deben ser publicadas por sus anunciantes. Antes de afirmar un impacto local, se deben recopilar datos verificables y fechados, y citar su fuente.

Para el pitch, presenta el problema local como una hipótesis del equipo hasta validarlo con entrevistas o datos fechados; no afirmes tasas ni resultados que no se hayan medido. Para sustentar el impacto, registra oportunidades verificadas en VES, postulaciones completadas, anunciantes que responden y colocaciones confirmadas. No reportes metas como resultados alcanzados.

## Accesibilidad

La interfaz incluye idioma español, enlace para saltar al contenido, landmarks y encabezados, etiquetas asociadas a los campos, texto alternativo, mensajes de estado, foco visible y preferencia de movimiento reducido. Estos elementos son buenas prácticas; **no constituyen una certificación WCAG** ni reemplazan pruebas con personas usuarias.

Antes de una demostración, comprobar con teclado:

- `Tab` y `Shift+Tab` recorren controles en un orden comprensible y el foco siempre se distingue.
- `Enter` y `Espacio` activan enlaces y botones; `Escape` cierra los diálogos.
- Los campos muestran sus etiquetas y los errores/confirmaciones se anuncian.
- Ampliar el zoom y revisar que no haya contenido cortado en móvil.

Queda pendiente una prueba con lector de pantalla y usuarios con distintas necesidades de acceso.

## Tecnologías y estructura

- **Frontend:** HTML, CSS y JavaScript sin framework.
- **Backend:** Python `http.server`, endpoints JSON y Server-Sent Events.
- **Autenticación:** Firebase Authentication.
- **Persistencia:** SQLite.
- `index.html`: selección de modalidad.
- `trabajorapido.html` y `trabajoformal.html`: páginas por modalidad.
- `script.js`: ofertas, perfiles, postulaciones y mensajería.
- `landing.js`: cuenta y sesión en la portada.
- `server.py`: API, validación y persistencia.

## Ejecutar localmente

Requisitos: Python 3 y Node.js para las comprobaciones de sintaxis.

```powershell
git clone https://github.com/juarezangelhack-crypto/Chamby.git
cd Chamby
python -m pip install -r requirements.txt
python server.py
```

Abre <http://127.0.0.1:4173/>. El servidor usa `PORT` si está definido; por defecto utiliza `4173`. Para probar autenticación local también se necesita configurar `FIREBASE_API_KEY` en el entorno del proceso. No incluyas credenciales privadas ni claves de servicio de Firebase en el repositorio.

La base local se crea como `encuentralab.db` junto al servidor por defecto. Se puede cambiar con `DATA_DIR` o `DATABASE_PATH`. Railway conserva la base de producción en su volumen persistente; no reemplaces ese archivo con una base local.

## Comprobaciones

```powershell
python -m py_compile server.py
node --check script.js
node --check landing.js
git diff --check
```

El repositorio no incluye una suite automatizada de pruebas de navegador. El flujo de postulación, perfil, chat y retiro de postulación se ha probado manualmente con datos aislados; antes de una presentación conviene repetir el recorrido completo en el entorno de demo.

## Colaborar y publicar

El repositorio es público: cualquiera puede clonarlo o crear un *fork*. Para subir directamente a `main`, se necesita permiso de colaborador; de lo contrario, se puede proponer un *pull request*.

La publicación de esta aplicación se realiza en Railway. Una persona con acceso al proyecto puede iniciar sesión, vincular el servicio y desplegar:

```powershell
railway login
railway link
railway up --detach
```

No incluyas `encuentralab.db`, CV, fotos de usuarios ni credenciales en commits. El archivo de base de datos local y `.env` están excluidos por `.gitignore`.

## Roles sugeridos para el equipo

Completa los nombres y acuerda los roles antes de las 10:00 a. m.; la pauta indica que después de esa hora no se cambia el equipo. Los roles siguientes son una propuesta, no asignaciones ya confirmadas.

| Rol | Responsabilidad |
| --- | --- |
| Producto e investigación | Definir el problema, validar el ODS y verificar las fuentes/datos de VES. |
| Backend y datos | API, SQLite, autenticación e integridad de las postulaciones. |
| Frontend y accesibilidad | Pantallas, navegación, perfiles y pruebas de acceso. |
| QA y presentación | Ensayar el flujo, comprobar estabilidad y controlar el tiempo del pitch. |

Con un equipo más pequeño se pueden combinar responsabilidades.

## Presentación

El borrador de cinco diapositivas y el guion de aproximadamente tres minutos están en [`PRESENTACION.md`](PRESENTACION.md).
