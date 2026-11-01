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

Opcional (pestaña **Variables**): `FTP_SERVER_DIR` si la web no debe ir a
`public_html/` (por defecto). Si tu usuario FTP entra directamente en la
carpeta del dominio, `public_html/` es lo correcto. Si entra en la raíz de
la cuenta, usa `domains/velocebikes.es/public_html/`.

### 3. Dominio
En Hostinger, el dominio `velocebikes.es` debe apuntar al hosting
(nameservers `ns1.dns-parking.com` / `ns2.dns-parking.com`, o registros A
a la IP del hosting). Si antes apuntaba a GitHub Pages, quita esos
registros (185.199.108–111.153) y desactiva GitHub Pages en
**Settings → Pages** para no tener dos webs.

### 4. Primer despliegue
**Actions → Deploy a Hostinger → Run workflow**, o haz cualquier push a `main`.

## Si falla
- *Login authentication failed*: revisa usuario/contraseña en los secretos.
- *Error de TLS/FTPS*: cambia `protocol: ftps` por `protocol: ftp` en el workflow.
- La web sale en otra carpeta: ajusta la variable `FTP_SERVER_DIR`.
