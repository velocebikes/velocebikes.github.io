<?php
// ═══════════════════════════════════════════════════════════════════
//  API del CRM de Veloce Bikes
//  Guarda los datos del CRM en la base de datos del hosting para que
//  se puedan usar desde cualquier dispositivo, con login de servidor.
//
//  La configuración (base de datos, contraseña inicial) está en
//  config.php, que NO está en el repositorio: lo genera el despliegue
//  automático a partir de los secrets de GitHub.
// ═══════════════════════════════════════════════════════════════════
declare(strict_types=1);

const KEY_RE = '/^vcr_[a-z0-9_]{1,40}$/';
// Datos de contabilidad: solo los ven los usuarios con permiso "conta".
const CONTA_KEYS = ['vcr_ops', 'vcr_gastos', 'vcr_reparto', 'vcr_contacfg'];
const MAX_VALUE_BYTES = 20 * 1024 * 1024;
const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const IDLE_SECONDS = 8 * 3600;
// Usuarios del CRM. Al crearse por primera vez usan la contraseña
// inicial (secret CRM_INITIAL_PASSWORD) y deben cambiarla al entrar.
const DEFAULT_USERS = [
    ['julio', 'Julio', 1],
    ['hugo', 'Hugo', 1],
    ['empleado2', 'Empleado 2', 0],
];

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');

if (!is_file(__DIR__ . '/config.php')) {
    http_response_code(503);
    echo json_encode(['error' => 'El CRM todavía no está configurado en el servidor.'], JSON_UNESCAPED_UNICODE);
    exit;
}
$CFG = require __DIR__ . '/config.php';

function out($data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $msg, int $code = 400, array $extra = []): void
{
    out(['error' => $msg] + $extra, $code);
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || ($_SERVER['SERVER_PORT'] ?? '') === '443'
        || strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function db(): PDO
{
    static $pdo = null;
    global $CFG;
    if ($pdo) return $pdo;
    $pdo = new PDO($CFG['dsn'], $CFG['db_user'] ?? null, $CFG['db_pass'] ?? null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void
{
    $pdo->exec('CREATE TABLE IF NOT EXISTS crm_users (
        username VARCHAR(40) PRIMARY KEY,
        nombre VARCHAR(80) NOT NULL,
        pass_hash VARCHAR(255) NOT NULL,
        conta INT NOT NULL DEFAULT 0,
        must_change INT NOT NULL DEFAULT 1,
        fails INT NOT NULL DEFAULT 0,
        locked_until BIGINT NOT NULL DEFAULT 0)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS crm_meta (
        id INT PRIMARY KEY,
        rev BIGINT NOT NULL)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS crm_kv (
        k VARCHAR(64) PRIMARY KEY,
        v LONGTEXT,
        rev BIGINT NOT NULL,
        updated_by VARCHAR(40),
        updated_at BIGINT)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS crm_docs (
        id VARCHAR(40) PRIMARY KEY,
        veh_id VARCHAR(40) NOT NULL,
        parte VARCHAR(20),
        titulo VARCHAR(200),
        nombre VARCHAR(255),
        tipo VARCHAR(120),
        size BIGINT,
        fecha VARCHAR(20),
        created_by VARCHAR(40),
        created_at BIGINT)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS crm_log (
        at BIGINT NOT NULL,
        username VARCHAR(40),
        ip VARCHAR(64),
        accion VARCHAR(40),
        detalle VARCHAR(255))');
    if (!$pdo->query('SELECT 1 FROM crm_meta WHERE id = 1')->fetch()) $pdo->exec('INSERT INTO crm_meta (id, rev) VALUES (1, 0)');
}

function seed_users(): void
{
    global $CFG;
    $initial = (string)($CFG['initial_password'] ?? '');
    if (strlen($initial) < 8) return;
    $pdo = db();
    $ins = $pdo->prepare('INSERT INTO crm_users (username, nombre, pass_hash, conta, must_change) VALUES (?, ?, ?, ?, 1)');
    $get = $pdo->prepare('SELECT pass_hash, must_change FROM crm_users WHERE username = ?');
    $upd = $pdo->prepare('UPDATE crm_users SET pass_hash = ? WHERE username = ? AND must_change = 1');
    foreach (DEFAULT_USERS as [$u, $n, $c]) {
        $get->execute([$u]);
        $row = $get->fetch();
        if (!$row) {
            $ins->execute([$u, $n, password_hash($initial, PASSWORD_DEFAULT), $c]);
        } elseif ($row['must_change'] && !password_verify($initial, $row['pass_hash'])) {
            // Aún no ha puesto su propia contraseña: si se cambia el secret
            // CRM_INITIAL_PASSWORD, la contraseña inicial pasa a ser la nueva.
            $upd->execute([password_hash($initial, PASSWORD_DEFAULT), $u]);
        }
    }
}

function audit(string $accion, string $detalle = '', ?string $user = null): void
{
    try {
        db()->prepare('INSERT INTO crm_log (at, username, ip, accion, detalle) VALUES (?, ?, ?, ?, ?)')
            ->execute([time(), $user ?? ($_SESSION['u'] ?? null), $_SERVER['REMOTE_ADDR'] ?? '', $accion, mb_substr($detalle, 0, 255)]);
    } catch (Throwable $e) {
    }
}

function start_session(): void
{
    session_name('vbcrm');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    ini_set('session.use_strict_mode', '1');
    ini_set('session.gc_maxlifetime', (string)IDLE_SECONDS);
    session_start();
    if (isset($_SESSION['u']) && time() - ($_SESSION['t'] ?? 0) > IDLE_SECONDS) {
        $_SESSION = [];
        session_regenerate_id(true);
    }
    if (isset($_SESSION['u'])) $_SESSION['t'] = time();
}

function current_user(): array
{
    if (empty($_SESSION['u'])) fail('Sesión caducada. Vuelve a entrar.', 401);
    $st = db()->prepare('SELECT username, nombre, conta, must_change FROM crm_users WHERE username = ?');
    $st->execute([$_SESSION['u']]);
    $u = $st->fetch();
    if (!$u) {
        $_SESSION = [];
        fail('Sesión caducada. Vuelve a entrar.', 401);
    }
    return $u;
}

function user_out(array $u): array
{
    return ['user' => $u['username'], 'nombre' => $u['nombre'], 'conta' => (bool)$u['conta'], 'mustChange' => (bool)$u['must_change']];
}

function can_key(array $u, string $k): bool
{
    return preg_match(KEY_RE, $k) === 1 && ($u['conta'] || !in_array($k, CONTA_KEYS, true));
}

function next_rev(PDO $pdo): int
{
    $pdo->exec('UPDATE crm_meta SET rev = rev + 1 WHERE id = 1');
    return (int)$pdo->query('SELECT rev FROM crm_meta WHERE id = 1')->fetchColumn();
}

function body(): array
{
    $raw = file_get_contents('php://input');
    $d = json_decode($raw ?: '{}', true);
    return is_array($d) ? $d : [];
}

function docs_dir(): string
{
    global $CFG;
    // Fuera de public_html: no se puede abrir desde internet.
    $dir = $CFG['docs_dir'] ?? (dirname(__DIR__, 2) . '/crm-docs');
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    return $dir;
}

function doc_path(string $id): string
{
    if (!preg_match('/^[A-Za-z0-9_-]{1,40}$/', $id)) fail('Documento no válido.');
    return docs_dir() . '/' . $id . '.bin';
}

// ─────────────────────────────── Router ───────────────────────────────
$action = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

if (empty($CFG['allow_insecure']) && !is_https()) {
    fail('El CRM solo funciona con conexión segura (https).', 403);
}

// Protección CSRF: toda escritura debe llevar esta cabecera, que un
// formulario de otra web no puede enviar.
if ($method !== 'GET' && ($_SERVER['HTTP_X_CRM'] ?? '') !== '1') fail('Petición no permitida.', 403);

// ── Parte pública (sin login): stock de la web y desperfectos de las motos
// en venta. Solo motos Visibles/Reservadas y solo datos públicos: nunca
// matrícula, bastidor, costes ni nada de clientes.
function kv_json(string $k): array
{
    $st = db()->prepare('SELECT v FROM crm_kv WHERE k = ?');
    $st->execute([$k]);
    $d = json_decode((string)$st->fetchColumn(), true);
    return is_array($d) ? $d : [];
}
function vehiculo_publico(string $id): ?array
{
    foreach (kv_json('vcr_vehiculos') as $v) {
        if (is_array($v) && (string)($v['id'] ?? '') === $id && in_array($v['estado'] ?? '', ['Visible', 'Reservado'], true)) return $v;
    }
    return null;
}
function desperfectos_publicos(string $vehId): array
{
    $d = kv_json('vcr_desperfectos')[$vehId] ?? [];
    $fotos = [];
    foreach ((array)($d['fotos'] ?? []) as $f) {
        if (is_array($f) && preg_match('/^[A-Za-z0-9_-]{1,40}$/', (string)($f['id'] ?? ''))) $fotos[] = ['id' => (string)$f['id'], 'nota' => mb_substr((string)($f['nota'] ?? ''), 0, 300)];
    }
    return ['fotos' => array_slice($fotos, 0, 6), 'obs' => mb_substr((string)($d['obs'] ?? ''), 0, 1000)];
}
function url_https(string $u): string
{
    return preg_match('#^https://[^\s"<>]+$#', $u) ? $u : '';
}

if ($method === 'GET' && in_array($action, ['stock', 'desperfectos', 'dfoto'], true)) {
    try {
        if ($action === 'stock') {
            $pub = [];
            foreach (kv_json('vcr_vehiculos') as $v) {
                if (!is_array($v) || !in_array($v['estado'] ?? '', ['Visible', 'Reservado'], true)) continue;
                $fotos = array_values(array_filter((array)($v['fotos'] ?? []), fn($f) => is_string($f) && url_https($f) !== ''));
                $vid = (string)($v['id'] ?? '');
                $df = desperfectos_publicos($vid)['fotos'];
                $nd = count($df);
                $pub[] = [
                    'id' => $v['id'] ?? null, 'marca' => (string)($v['marca'] ?? ''), 'modelo' => (string)($v['modelo'] ?? ''),
                    'año' => $v['año'] ?? '', 'cv' => $v['cv'] ?? '', 'cc' => $v['cc'] ?? '', 'km' => $v['km'] ?? '',
                    'garantia' => $v['garantia'] ?? '', 'extras' => (string)($v['extras'] ?? ''), 'estado' => $v['estado'],
                    'precio' => $v['precio'] ?? '', 'fotos' => $fotos,
                    'video' => url_https((string)($v['video'] ?? '')), 'desperfectos' => $nd,
                    'desp_portada' => $nd ? 'api/index.php?' . http_build_query(['a' => 'dfoto', 'veh' => $vid, 'id' => $df[0]['id']]) : '',
                ];
            }
            header('Cache-Control: public, max-age=60', true);
            out(['vehiculos' => $pub]);
        }
        $veh = (string)($_GET['veh'] ?? '');
        $v = vehiculo_publico($veh);
        if (!$v) fail('No disponible.', 404);
        $d = desperfectos_publicos($veh);
        if ($action === 'desperfectos') {
            header('Cache-Control: public, max-age=60', true);
            out([
                'vehiculo' => ['marca' => (string)($v['marca'] ?? ''), 'modelo' => (string)($v['modelo'] ?? ''), 'año' => $v['año'] ?? '', 'km' => $v['km'] ?? ''],
                'obs' => $d['obs'],
                'fotos' => array_map(fn($f) => ['nota' => $f['nota'], 'url' => 'api/index.php?' . http_build_query(['a' => 'dfoto', 'veh' => $veh, 'id' => $f['id']])], $d['fotos']),
            ]);
        }
        // dfoto: solo fotos que están en los desperfectos de esa moto
        $id = (string)($_GET['id'] ?? '');
        if (!in_array($id, array_column($d['fotos'], 'id'), true)) fail('No disponible.', 404);
        $st = db()->prepare('SELECT tipo FROM crm_docs WHERE id = ? AND veh_id = ? AND parte = ?');
        $st->execute([$id, $veh, 'desperfecto']);
        $tipo = (string)$st->fetchColumn();
        $path = doc_path($id);
        if (!$tipo || !is_file($path) || !preg_match('#^image/(jpeg|png|webp|gif|heic|heif)$#', $tipo)) fail('No disponible.', 404);
        header_remove('Content-Type');
        header('Content-Type: ' . $tipo);
        header('Content-Length: ' . filesize($path));
        header('Cache-Control: public, max-age=300', true);
        readfile($path);
        exit;
    } catch (Throwable $e) {
        error_log('CRM API pública: ' . $e->getMessage());
        fail('Error del servidor.', 500);
    }
}

try {
    start_session();

    switch ($action) {
        case 'login': {
            seed_users();
            $b = body();
            $user = strtolower(trim((string)($b['user'] ?? '')));
            $pass = (string)($b['pass'] ?? '');
            $pdo = db();
            $st = $pdo->prepare('SELECT * FROM crm_users WHERE username = ?');
            $st->execute([$user]);
            $u = $st->fetch();
            if ($u && $u['locked_until'] > time()) {
                audit('login_bloqueado', '', $user);
                fail('Demasiados intentos. Espera 15 minutos.', 429);
            }
            if (!$u || !password_verify($pass, $u['pass_hash'])) {
                if ($u) {
                    $fails = $u['fails'] + 1;
                    $pdo->prepare('UPDATE crm_users SET fails = ?, locked_until = ? WHERE username = ?')
                        ->execute([$fails >= MAX_FAILS ? 0 : $fails, $fails >= MAX_FAILS ? time() + LOCK_SECONDS : 0, $user]);
                }
                audit('login_fallido', '', $user);
                usleep(700000);
                fail('Usuario o contraseña incorrectos.', 401);
            }
            $pdo->prepare('UPDATE crm_users SET fails = 0, locked_until = 0 WHERE username = ?')->execute([$user]);
            session_regenerate_id(true);
            $_SESSION['u'] = $user;
            $_SESSION['t'] = time();
            audit('login');
            out(user_out($u));
        }

        case 'logout':
            audit('logout');
            $_SESSION = [];
            session_destroy();
            out(['ok' => true]);

        case 'me':
            out(user_out(current_user()));

        case 'password': {
            $u = current_user();
            $b = body();
            $new = (string)($b['new'] ?? '');
            $st = db()->prepare('SELECT pass_hash FROM crm_users WHERE username = ?');
            $st->execute([$u['username']]);
            if (!password_verify((string)($b['old'] ?? ''), (string)$st->fetchColumn())) fail('La contraseña actual no es correcta.');
            if (mb_strlen($new) < 10) fail('La contraseña nueva debe tener al menos 10 caracteres.');
            if ($new === ($b['old'] ?? '')) fail('La contraseña nueva debe ser distinta de la actual.');
            db()->prepare('UPDATE crm_users SET pass_hash = ?, must_change = 0 WHERE username = ?')
                ->execute([password_hash($new, PASSWORD_DEFAULT), $u['username']]);
            session_regenerate_id(true);
            audit('cambio_password');
            out(['ok' => true]);
        }

        case 'pull': {
            $u = current_user();
            $since = (int)($_GET['since'] ?? 0);
            $pdo = db();
            $st = $pdo->prepare('SELECT k, v, rev FROM crm_kv WHERE rev > ?');
            $st->execute([$since]);
            $keys = [];
            foreach ($st as $r) {
                if (can_key($u, $r['k'])) $keys[$r['k']] = ['v' => $r['v'], 'rev' => (int)$r['rev']];
            }
            $rev = (int)$pdo->query('SELECT rev FROM crm_meta WHERE id = 1')->fetchColumn();
            $empty = $since === 0 && !$pdo->query('SELECT 1 FROM crm_kv LIMIT 1')->fetch();
            out(['rev' => $rev, 'keys' => (object)$keys, 'empty' => $empty]);
        }

        case 'put': {
            $u = current_user();
            if ($u['must_change']) fail('Cambia tu contraseña antes de seguir.', 403);
            $b = body();
            $k = (string)($b['k'] ?? '');
            if (!can_key($u, $k)) fail('No tienes permiso para guardar estos datos.', 403);
            $v = $b['v'] ?? null;
            if ($v !== null && !is_string($v)) fail('Datos no válidos.');
            if ($v !== null && strlen($v) > MAX_VALUE_BYTES) fail('Demasiados datos de una vez.');
            $base = (int)($b['base'] ?? 0);
            $pdo = db();
            $pdo->beginTransaction();
            $rev = next_rev($pdo); // bloquea crm_meta: las escrituras van de una en una
            $st = $pdo->prepare('SELECT v, rev FROM crm_kv WHERE k = ?');
            $st->execute([$k]);
            $cur = $st->fetch();
            $curRev = $cur ? (int)$cur['rev'] : 0;
            if ($curRev !== $base) {
                $pdo->rollBack();
                out(['conflict' => true, 'v' => $cur ? $cur['v'] : null, 'rev' => $curRev], 409);
            }
            $up = $pdo->prepare('UPDATE crm_kv SET v = ?, rev = ?, updated_by = ?, updated_at = ? WHERE k = ?');
            $up->execute([$v, $rev, $u['username'], time(), $k]);
            if ($up->rowCount() === 0) {
                $pdo->prepare('INSERT INTO crm_kv (k, v, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)')
                    ->execute([$k, $v, $rev, $u['username'], time()]);
            }
            $pdo->commit();
            out(['rev' => $rev]);
        }

        case 'docs': {
            current_user();
            $veh = $_GET['veh'] ?? null;
            $sql = 'SELECT id, veh_id AS vehId, parte, titulo, nombre, tipo, size, fecha FROM crm_docs';
            $st = db()->prepare($veh === null ? $sql : $sql . ' WHERE veh_id = ?');
            $st->execute($veh === null ? [] : [(string)$veh]);
            $rows = $st->fetchAll();
            foreach ($rows as &$r) $r['size'] = (int)$r['size'];
            out($rows);
        }

        case 'doc': {
            current_user();
            $id = (string)($_GET['id'] ?? '');
            $st = db()->prepare('SELECT nombre, tipo FROM crm_docs WHERE id = ?');
            $st->execute([$id]);
            $d = $st->fetch();
            $path = doc_path($id);
            if (!$d || !is_file($path)) fail('Documento no encontrado.', 404);
            audit('ver_doc', $id);
            header_remove('Content-Type');
            $tipo = preg_match('#^[\w.+-]+/[\w.+-]+$#', (string)$d['tipo']) ? $d['tipo'] : 'application/octet-stream';
            header('Content-Type: ' . $tipo);
            header('Content-Length: ' . filesize($path));
            // Solo PDF e imágenes se abren en el navegador; el resto se descarga.
            $inline = $tipo === 'application/pdf' || (str_starts_with($tipo, 'image/') && $tipo !== 'image/svg+xml');
            if (!empty($_GET['dl'])) $inline = false;
            if (!$inline) header('Content-Type: application/octet-stream', true);
            header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename*=UTF-8\'\'' . rawurlencode((string)$d['nombre']));
            readfile($path);
            exit;
        }

        case 'doc_upload': {
            $u = current_user();
            if ($u['must_change']) fail('Cambia tu contraseña antes de seguir.', 403);
            $f = $_FILES['file'] ?? null;
            if (!$f || $f['error'] !== UPLOAD_ERR_OK) fail('No se ha podido subir el archivo (¿pesa demasiado?).');
            if ($f['size'] > MAX_DOC_BYTES) fail('El archivo pesa más de 25 MB.');
            $m = json_decode((string)($_POST['meta'] ?? '{}'), true) ?: [];
            $id = (string)($m['id'] ?? '');
            $path = doc_path($id);
            if (!move_uploaded_file($f['tmp_name'], $path)) fail('No se ha podido guardar el archivo.', 500);
            chmod($path, 0600);
            $pdo = db();
            $pdo->prepare('DELETE FROM crm_docs WHERE id = ?')->execute([$id]);
            $pdo->prepare('INSERT INTO crm_docs (id, veh_id, parte, titulo, nombre, tipo, size, fecha, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute([$id, (string)($m['vehId'] ?? ''), mb_substr((string)($m['parte'] ?? ''), 0, 20), mb_substr((string)($m['titulo'] ?? ''), 0, 200),
                    mb_substr((string)($m['nombre'] ?? 'documento'), 0, 255), mb_substr((string)($m['tipo'] ?? ''), 0, 120), (int)$f['size'],
                    mb_substr((string)($m['fecha'] ?? ''), 0, 20), $u['username'], time()]);
            audit('subir_doc', $id);
            out(['ok' => true]);
        }

        case 'doc_delete': {
            $u = current_user();
            if ($u['must_change']) fail('Cambia tu contraseña antes de seguir.', 403);
            $id = (string)(body()['id'] ?? '');
            $path = doc_path($id);
            db()->prepare('DELETE FROM crm_docs WHERE id = ?')->execute([$id]);
            if (is_file($path)) unlink($path);
            audit('borrar_doc', $id);
            out(['ok' => true]);
        }

        case 'doc_clear': {
            $u = current_user();
            if ($u['must_change']) fail('Cambia tu contraseña antes de seguir.', 403);
            foreach (db()->query('SELECT id FROM crm_docs')->fetchAll() as $r) {
                $p = doc_path($r['id']);
                if (is_file($p)) unlink($p);
            }
            db()->exec('DELETE FROM crm_docs');
            audit('borrar_todos_docs');
            out(['ok' => true]);
        }

        default:
            fail('Acción desconocida.', 404);
    }
} catch (Throwable $e) {
    error_log('CRM API: ' . $e->getMessage());
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) $pdo->rollBack();
    fail('Error del servidor. Inténtalo de nuevo.', 500);
}
