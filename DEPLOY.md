# Despliegue automático en Hostinger

Cada vez que se hace un push a la rama `main`, GitHub Actions sube la web
a Hostinger por FTP (`.github/workflows/deploy-hostinger.yml`). Solo se
suben los archivos que han cambiado.

## Configuración (una sola vez)

### 1. Datos FTP en Hostinger
hPanel → **Sitios web** → velocebikes.es → **Archivos → Cuentas FTP**.
Apunta:
- **Host / IP FTP** (p. ej. `ftp.velocebikes.es` o una IP)
- **Usuario FTP** (p. ej. `u123456789` o `u123456789.velocebikes.es`)
- **Contraseña FTP** (si no la sabes, usa "Cambiar contraseña FTP")

### 2. Secretos en GitHub
Repositorio → **Settings → Secrets and variables → Actions → New repository secret**:

| Nombre          | Valor                 |
|-----------------|-----------------------|
| `FTP_SERVER`    | Host FTP de Hostinger |
| `FTP_USERNAME`  | Usuario FTP           |
| `FTP_PASSWORD`  | Contraseña FTP        |

La web se sube a `domains/velocebikes.es/public_html/`, que es la carpeta
real del sitio en Hostinger (el usuario FTP principal entra en la raíz de la
cuenta). Para cambiarla sin tocar el workflow, crea la variable
`FTP_SERVER_DIR` en la pestaña **Variables**.

### 3. Dominio (registrado en DonDominio)
Primero, en hPanel añade `velocebikes.es` como sitio web/dominio del hosting.
Después, en DonDominio elige **una** de estas dos opciones:

**Opción A – Cambiar los DNS a Hostinger (la más sencilla)**
DonDominio → Dominios → velocebikes.es → **Servidores DNS** → personalizados:
- `ns1.dns-parking.com`
- `ns2.dns-parking.com`

Ojo: si tienes correo en DonDominio, dejará de funcionar salvo que vuelvas a crear
los registros MX en Hostinger.

**Opción B – Mantener los DNS en DonDominio (recomendada si usas correo allí)**
DonDominio → Dominios → velocebikes.es → **Zona DNS**:
- Borra los registros A de GitHub Pages (`185.199.108.153`, `.109.153`,
  `.110.153`, `.111.153`) y el CNAME `www` → `velocebikes.github.io`.
- Crea un registro **A** `@` → IP del hosting (hPanel → Detalles del plan / Información de la cuenta).
- Crea un registro **CNAME** `www` → `velocebikes.es` (o un registro A `www` con la misma IP).

La propagación tarda de minutos a 24-48 h. Después activa el **SSL gratuito**
en hPanel → Seguridad → SSL, y desactiva GitHub Pages en
**Settings → Pages** para no tener dos webs.

### 4. Primer despliegue
**Actions → Deploy a Hostinger → Run workflow**, o haz cualquier push a `main`.

## Si falla
- *Login authentication failed*: revisa usuario/contraseña en los secretos.
- *Error de TLS/FTPS*: cambia `protocol: ftps` por `protocol: ftp` en el workflow.
- La web sale en otra carpeta: ajusta la variable `FTP_SERVER_DIR`.

## CRM con datos en el servidor

`crm.html` guarda los datos en la base de datos MySQL de Hostinger a través
de `api/index.php`, así que se puede usar desde cualquier dispositivo.

- **Login de servidor**: usuarios `julio`, `hugo` (con contabilidad) y
  `empleado2`. La primera vez entran con `CRM_INITIAL_PASSWORD` y el CRM
  obliga a cambiarla. Tras 5 intentos fallidos el usuario se bloquea 15 min.
- **Documentos**: se guardan en `domains/velocebikes.es/crm-docs/`, fuera de
  `public_html`, y solo se entregan con sesión iniciada.
- **Solo con https**: la API se niega a funcionar sin SSL.
- **Primera vez**: entrar desde el navegador que tiene los datos actuales;
  el CRM ofrece subirlos (incluidos los documentos) al servidor.
- `api/config.php` lo genera el despliegue con los secrets `DB_NAME`,
  `DB_USER`, `DB_PASSWORD` y `CRM_INITIAL_PASSWORD`. No está en el repositorio.
