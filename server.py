import base64
import binascii
import hashlib
import json
import os
import secrets
import sqlite3
import time
import unicodedata
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

PORT = int(os.getenv("PORT", "4173"))
MAX_APPLICANTS_PER_JOB = 10
DATA_DIR = os.getenv("DATA_DIR", os.path.dirname(__file__))
os.makedirs(DATA_DIR, exist_ok=True)
DB = os.getenv("DATABASE_PATH", os.path.join(DATA_DIR, "encuentralab.db"))

LIMA_DISTRICTS = {
    "ancón","ate","barranco","breña","carabayllo","chaclacayo","chorrillos","cieneguilla",
    "comas","el agustino","independencia","jesús maría","la molina","la victoria","lince",
    "los olivos","lurigancho","lurín","magdalena del mar","miraflores","pachacámac",
    "pucusana","pueblo libre","puente piedra","rímac","san bartolo","san borja","san isidro",
    "san juan de lurigancho","san juan de miraflores","san luis","san martín de porres",
    "santa anita","santa maría del mar","santa rosa","santiago de surco","surquillo",
    "villa el salvador","villa maría del triunfo"
}

def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con

def normalize_district(value):
    return unicodedata.normalize("NFD", value).encode("ascii", "ignore").decode("ascii").strip().lower()

def init_db():
    con = db()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      district TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verification_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      pending_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS firebase_pending_users (
      firebase_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      district TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      city TEXT NOT NULL,
      pay TEXT NOT NULL,
      schedule TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Abierto',
      applicant_limit INTEGER NOT NULL DEFAULT 10 CHECK(applicant_limit BETWEEN 1 AND 10),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      applicant_id TEXT NOT NULL,
      applicant_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pendiente',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT NOT NULL,
      profile_type TEXT NOT NULL CHECK(profile_type IN ('Rapido','Formal')),
      district TEXT NOT NULL,
      photo_mime TEXT,
      photo_data TEXT,
      cv_name TEXT,
      cv_data BLOB,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, profile_type)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    """)
    job_columns = {row["name"] for row in con.execute("PRAGMA table_info(jobs)").fetchall()}
    if "applicant_limit" not in job_columns:
        con.execute(
            "ALTER TABLE jobs ADD COLUMN applicant_limit INTEGER NOT NULL DEFAULT 10 "
            "CHECK(applicant_limit BETWEEN 1 AND 10)"
        )
    con.commit()
    con.close()

def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 240000)
    return f"{salt}${digest.hex()}"

def verify_password(password, stored):
    salt, expected = stored.split("$", 1)
    return secrets.compare_digest(hash_password(password, salt).split("$", 1)[1], expected)

class FirebaseError(Exception):
    def __init__(self, code):
        self.code = code

def firebase_request(method, payload):
    api_key = os.getenv("FIREBASE_API_KEY")
    if not api_key:
        raise FirebaseError("FIREBASE_NOT_CONFIGURED")
    request = urllib.request.Request(
        f"https://identitytoolkit.googleapis.com/v1/{method}?key={api_key}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            details = json.loads(error.read()).get("error", {}).get("message", "FIREBASE_ERROR")
        except (json.JSONDecodeError, AttributeError):
            details = "FIREBASE_ERROR"
        raise FirebaseError(details) from error
    except urllib.error.URLError as error:
        raise FirebaseError("FIREBASE_UNAVAILABLE") from error

def firebase_error_response(code):
    if code == "EMAIL_EXISTS":
        return 409, {"error": "Ya existe una cuenta con ese correo."}
    if code in {"INVALID_LOGIN_CREDENTIALS", "EMAIL_NOT_FOUND", "INVALID_PASSWORD", "USER_DISABLED"}:
        return 401, {"error": "Correo o contraseña incorrectos."}
    if code.startswith("WEAK_PASSWORD"):
        return 400, {"error": "La contraseña no cumple los requisitos de Firebase."}
    if code in {"OPERATION_NOT_ALLOWED", "CONFIGURATION_NOT_FOUND"}:
        return 503, {"error": "Activa Email/Contraseña en la configuración de autenticación de Firebase."}
    if code == "API_KEY_INVALID":
        return 503, {"error": "La clave web de Firebase no es válida. Revisa FIREBASE_API_KEY."}
    if code == "FIREBASE_NOT_CONFIGURED":
        return 503, {"error": "Configura FIREBASE_API_KEY en el entorno del servidor para habilitar el inicio de sesión."}
    if code == "INVALID_CONTINUE_URI":
        return 503, {"error": "Agrega el dominio de Chamby a los dominios autorizados de Firebase."}
    if code == "FIREBASE_UNAVAILABLE":
        return 503, {"error": "No se pudo conectar con Firebase. Inténtalo de nuevo."}
    return 400, {"error": "Firebase no pudo completar la solicitud. Revisa la configuración del proyecto."}

class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.dirname(__file__), **kwargs)

    def json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or "{}")

    def respond(self, status, payload, cookie=None):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def respond_bytes(self, status, payload, content_type, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "private, no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(payload)

    def cookie_token(self):
        raw = self.headers.get("Cookie", "")
        for item in raw.split(";"):
            if item.strip().startswith("encuentralab_session="):
                return item.strip().split("=", 1)[1]
        return None

    def session_cookie(self, token, max_age):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"encuentralab_session={token}; Path=/; HttpOnly; SameSite=Strict{secure}; Max-Age={max_age}"

    def current_user(self):
        token = self.cookie_token()
        if not token:
            return None
        con = db()
        row = con.execute(
            "SELECT u.id,u.name,u.email,u.district FROM sessions s "
            "JOIN users u ON u.id=s.user_id "
            "WHERE s.token=? AND s.expires_at>? AND u.verified=1",
            (token, int(time.time()))
        ).fetchone()
        con.close()
        return dict(row) if row else None

    def profile_type(self, query):
        value = query.get("type", [None])[0]
        if value not in {"Rapido", "Formal"}:
            self.respond(400, {"error": "La modalidad del perfil no es válida."})
            return None
        return value

    def profile_data(self, user_id, profile_type, row=None):
        con = db()
        account = con.execute("SELECT name FROM users WHERE id=?", (user_id,)).fetchone()
        con.close()
        if not account:
            return None
        return {
            "userId": user_id,
            "name": account["name"],
            "profileType": profile_type,
            "district": row["district"] if row else "",
            "photoMime": row["photo_mime"] if row else None,
            "photoData": row["photo_data"] if row else None,
            "cvName": row["cv_name"] if row else None
        }

    def can_view_applicant_profile(self, user_id, applicant_id, job_id, profile_type):
        if not job_id:
            return False
        con = db()
        application = con.execute(
            "SELECT 1 FROM jobs j JOIN applications a ON a.job_id=j.id "
            "WHERE j.id=? AND j.owner_id=? AND j.type=? AND a.applicant_id=?",
            (job_id, user_id, profile_type, applicant_id)
        ).fetchone()
        con.close()
        return bool(application)

    def get_profile(self, profile_user_id, query):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Inicia sesión para ver los perfiles."})
            return
        profile_type = self.profile_type(query)
        if not profile_type:
            return
        target_id = profile_user_id or user["id"]
        if target_id != user["id"] and not self.can_view_applicant_profile(
            user["id"], target_id, query.get("jobId", [None])[0], profile_type
        ):
            self.respond(403, {"error": "No tienes permiso para ver este perfil."})
            return
        con = db()
        row = con.execute(
            "SELECT * FROM user_profiles WHERE user_id=? AND profile_type=?",
            (target_id, profile_type)
        ).fetchone()
        con.close()
        profile = self.profile_data(target_id, profile_type, row)
        if not profile:
            self.respond(404, {"error": "No se encontró el perfil."})
            return
        self.respond(200, {"profile": profile})

    def get_profile_cv(self, profile_user_id, query):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Inicia sesión para ver este CV."})
            return
        profile_type = self.profile_type(query)
        if not profile_type:
            return
        if profile_user_id != user["id"] and not self.can_view_applicant_profile(
            user["id"], profile_user_id, query.get("jobId", [None])[0], profile_type
        ):
            self.respond(403, {"error": "No tienes permiso para ver este CV."})
            return
        con = db()
        row = con.execute(
            "SELECT cv_data FROM user_profiles WHERE user_id=? AND profile_type=?",
            (profile_user_id, profile_type)
        ).fetchone()
        con.close()
        if not row or not row["cv_data"]:
            self.respond(404, {"error": "Este perfil aún no tiene un CV."})
            return
        self.respond_bytes(
            200,
            bytes(row["cv_data"]),
            "application/pdf",
            {"Content-Disposition": 'inline; filename="curriculum.pdf"'}
        )

    def save_profile(self):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Inicia sesión para guardar tu perfil."})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.respond(400, {"error": "La solicitud no tiene un tamaño válido."})
            return
        if content_length < 0:
            self.respond(400, {"error": "La solicitud no tiene un tamaño válido."})
            return
        if content_length > 11 * 1024 * 1024:
            self.respond(413, {"error": "La foto y el CV superan el tamaño total permitido."})
            return
        try:
            data = self.json_body()
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.respond(400, {"error": "Los datos del perfil no son JSON válido."})
            return
        if not isinstance(data, dict):
            self.respond(400, {"error": "Los datos del perfil no son válidos."})
            return
        profile_type = data.get("type")
        if not isinstance(profile_type, str) or profile_type not in {"Rapido", "Formal"}:
            self.respond(400, {"error": "La modalidad del perfil no es válida."})
            return
        district = str(data.get("district", "")).strip()
        if normalize_district(district) not in {normalize_district(item) for item in LIMA_DISTRICTS}:
            self.respond(400, {"error": "Selecciona un distrito válido de Lima."})
            return

        photo_data = data.get("photoData")
        photo_mime = data.get("photoMime")
        photo_bytes = None
        if photo_data is not None or photo_mime is not None:
            if not isinstance(photo_mime, str) or photo_mime not in {"image/jpeg", "image/png", "image/webp"} or not isinstance(photo_data, str):
                self.respond(400, {"error": "La foto debe ser JPEG, PNG o WebP."})
                return
            if len(photo_data) > 3 * 1024 * 1024:
                self.respond(413, {"error": "La foto debe pesar como máximo 2 MB."})
                return
            try:
                photo_bytes = base64.b64decode(photo_data, validate=True)
            except (binascii.Error, ValueError):
                self.respond(400, {"error": "El archivo de foto no es válido."})
                return
            signatures = {
                "image/jpeg": photo_bytes.startswith(b"\xff\xd8\xff"),
                "image/png": photo_bytes.startswith(b"\x89PNG\r\n\x1a\n"),
                "image/webp": photo_bytes.startswith(b"RIFF") and photo_bytes[8:12] == b"WEBP"
            }
            if not photo_bytes or len(photo_bytes) > 2 * 1024 * 1024 or not signatures[photo_mime]:
                self.respond(400, {"error": "El contenido de la foto no coincide con su formato."})
                return

        cv_data = data.get("cvData")
        cv_name = data.get("cvName")
        cv_bytes = None
        if cv_data is not None or cv_name is not None:
            if not isinstance(cv_data, str) or not isinstance(cv_name, str) or not cv_name.lower().endswith(".pdf"):
                self.respond(400, {"error": "El CV debe ser un archivo PDF válido."})
                return
            if len(cv_data) > 7 * 1024 * 1024:
                self.respond(413, {"error": "El CV debe pesar como máximo 5 MB."})
                return
            try:
                cv_bytes = base64.b64decode(cv_data, validate=True)
            except (binascii.Error, ValueError):
                self.respond(400, {"error": "El archivo CV no es válido."})
                return
            if not cv_bytes.startswith(b"%PDF-") or len(cv_bytes) > 5 * 1024 * 1024:
                self.respond(400, {"error": "El contenido del CV no es un PDF válido."})
                return
            cv_name = os.path.basename(cv_name)[:120]

        con = db()
        con.execute(
            "INSERT INTO user_profiles(user_id,profile_type,district,photo_mime,photo_data,cv_name,cv_data,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,profile_type) DO UPDATE SET "
            "district=excluded.district,"
            "photo_mime=COALESCE(excluded.photo_mime,user_profiles.photo_mime),"
            "photo_data=COALESCE(excluded.photo_data,user_profiles.photo_data),"
            "cv_name=COALESCE(excluded.cv_name,user_profiles.cv_name),"
            "cv_data=COALESCE(excluded.cv_data,user_profiles.cv_data),"
            "updated_at=excluded.updated_at",
            (user["id"], profile_type, district, photo_mime if photo_bytes else None,
             base64.b64encode(photo_bytes).decode("ascii") if photo_bytes else None,
             cv_name if cv_bytes else None, sqlite3.Binary(cv_bytes) if cv_bytes else None, int(time.time()))
        )
        con.commit()
        row = con.execute(
            "SELECT * FROM user_profiles WHERE user_id=? AND profile_type=?",
            (user["id"], profile_type)
        ).fetchone()
        con.close()
        self.respond(200, {"profile": self.profile_data(user["id"], profile_type, row)})

    def messages_for_user(self, user):
        con = db()
        rows = con.execute(
            "SELECT m.*,j.title AS job_title,j.owner_id,j.owner_name,j.type AS job_type,"
            "u.name AS sender_name,u.district AS sender_district "
            "FROM messages m "
            "JOIN jobs j ON j.id=substr(m.conversation_id,1,instr(m.conversation_id,':')-1) "
            "LEFT JOIN users u ON u.id=m.sender_id "
            "WHERE j.owner_id=? OR instr(':'||m.conversation_id||':',':'||?||':')>0 "
            "ORDER BY m.created_at ASC",
            (user["id"], user["id"])
        ).fetchall()
        con.close()
        messages = []
        for row in rows:
            parts = row["conversation_id"].split(":")
            if len(parts) != 3 or len(set(parts[1:])) != 2:
                continue
            if user["id"] in parts[1:] and row["owner_id"] in parts[1:]:
                messages.append(dict(row))
        return messages

    def stream_messages(self):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Sesion requerida"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def send_chunk(content):
            self.wfile.write(f"{len(content):X}\r\n".encode("ascii") + content + b"\r\n")
            self.wfile.flush()

        last_message_ids = None
        last_heartbeat = time.monotonic()
        try:
            while True:
                messages = self.messages_for_user(user)
                message_ids = tuple(message["id"] for message in messages)
                if message_ids != last_message_ids:
                    event = json.dumps({"messages": messages}, ensure_ascii=False).encode("utf-8")
                    send_chunk(b"data: " + event + b"\n\n")
                    last_message_ids = message_ids
                    last_heartbeat = time.monotonic()
                elif time.monotonic() - last_heartbeat >= 15:
                    send_chunk(b": keep-alive\n\n")
                    last_heartbeat = time.monotonic()
                time.sleep(1)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            self.close_connection = True

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/api/session":
            user = self.current_user()
            self.respond(200 if user else 401, {"user": user})
            return
        if path == "/api/messages/stream":
            self.stream_messages()
            return
        if path == "/api/jobs":
            con = db()
            rows = con.execute(
                "SELECT j.*,(SELECT COUNT(*) FROM applications a WHERE a.job_id=j.id) AS applicant_count "
                "FROM jobs j ORDER BY j.created_at DESC"
            ).fetchall()
            con.close()
            self.respond(200, {"jobs": [dict(row) for row in rows]})
            return
        if path == "/api/applications":
            user = self.current_user()
            if not user:
                self.respond(401, {"error": "Sesion requerida"})
                return
            con = db()
            rows = con.execute(
                "SELECT a.*,u.name AS account_name,u.district AS account_district,j.type AS job_type,"
                "COALESCE(p.district,u.district) AS applicant_district "
                "FROM applications a JOIN users u ON u.id=a.applicant_id "
                "JOIN jobs j ON j.id=a.job_id "
                "LEFT JOIN user_profiles p ON p.user_id=a.applicant_id AND p.profile_type=j.type "
                "WHERE a.applicant_id=? OR a.job_id IN "
                "(SELECT id FROM jobs WHERE owner_id=?) ORDER BY a.created_at DESC",
                (user["id"], user["id"])
            ).fetchall()
            con.close()
            self.respond(200, {"applications": [dict(row) for row in rows]})
            return
        if path == "/api/profiles":
            self.get_profile(None, query)
            return
        if path.startswith("/api/profiles/"):
            parts = [unquote(part) for part in path[len("/api/profiles/"):].split("/")]
            if len(parts) == 2 and parts[1] == "cv":
                self.get_profile_cv(parts[0], query)
            elif len(parts) == 1:
                self.get_profile(parts[0], query)
            else:
                self.respond(404, {"error": "Ruta no encontrada"})
            return
        if path == "/api/messages":
            user = self.current_user()
            if not user:
                self.respond(401, {"error": "Sesion requerida"})
                return
            self.respond(200, {"messages": self.messages_for_user(user)})
            return
        if path.startswith("/api/"):
            self.respond(404, {"error": "Ruta no encontrada"})
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/register":
            self.register()
        elif self.path == "/api/login":
            self.login()
        elif self.path == "/api/password-reset":
            self.password_reset()
        elif self.path == "/api/logout":
            self.logout()
        elif self.path == "/api/jobs":
            self.create_job()
        elif self.path == "/api/profiles":
            self.save_profile()
        elif self.path == "/api/applications":
            self.create_application()
        elif self.path == "/api/messages":
            self.create_message()
        elif self.path == "/api/jobs/accept":
            self.accept_job()
        else:
            self.respond(404, {"error": "Ruta no encontrada"})

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/applications/"):
            self.delete_application(unquote(path[len("/api/applications/"):]))
            return
        if path.startswith("/api/jobs/"):
            self.delete_job(unquote(path[len("/api/jobs/"):]))
            return
        self.respond(404, {"error": "Ruta no encontrada"})

    def register(self):
        data = self.json_body()
        name = str(data.get("name", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        district = str(data.get("district", "")).strip()
        district_key = district.lower().replace("san juan de lurigancho","san juan de lurigancho")
        if len(name) < 3:
            self.respond(400, {"error": "Escribe tu nombre completo"})
            return
        if "@" not in email or "." not in email.rsplit("@", 1)[1]:
            self.respond(400, {"error": "Correo electrónico inválido"})
            return
        if len(password) < 6:
            self.respond(400, {"error": "La contraseña debe tener al menos 6 caracteres"})
            return
        if district_key not in LIMA_DISTRICTS:
            self.respond(400, {"error": "Selecciona un distrito de Lima"})
            return
        con = db()
        existing = con.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone()
        con.close()
        if existing:
            self.respond(409, {"error": "Ya existe una cuenta con este correo"})
            return
        try:
            firebase_user = firebase_request("accounts:signUp", {
                "email": email,
                "password": password,
                "returnSecureToken": True
            })
            firebase_id = firebase_user["localId"]
            con = db()
            con.execute(
                "INSERT OR REPLACE INTO firebase_pending_users(firebase_id,email,name,district) VALUES(?,?,?,?)",
                (firebase_id, email, name, district)
            )
            con.commit()
            con.close()
            firebase_request("accounts:sendOobCode", {
                "requestType": "VERIFY_EMAIL",
                "idToken": firebase_user["idToken"],
                "continueUrl": os.getenv("PUBLIC_URL", "https://chamby-production.up.railway.app/?verified=1")
            })
        except FirebaseError as error:
            print(f"Firebase registration error: {error.code}")
            self.respond(*firebase_error_response(error.code))
            return
        except sqlite3.Error:
            self.respond(500, {"error": "No se pudo guardar el perfil. Inténtalo de nuevo."})
            return
        self.respond(200, {"pending": True, "message": "Revisa tu correo y confirma el enlace para activar tu cuenta."})

    def login(self):
        data = self.json_body()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        try:
            firebase_user = firebase_request("accounts:signInWithPassword", {
                "email": email,
                "password": password,
                "returnSecureToken": True
            })
            account = firebase_request("accounts:lookup", {"idToken": firebase_user["idToken"]})
        except FirebaseError as error:
            time.sleep(0.25)
            self.respond(*firebase_error_response(error.code))
            return

        firebase_account = account.get("users", [{}])[0]
        if not firebase_account.get("emailVerified"):
            try:
                firebase_request("accounts:sendOobCode", {
                    "requestType": "VERIFY_EMAIL",
                    "idToken": firebase_user["idToken"],
                    "continueUrl": os.getenv("PUBLIC_URL", "https://chamby-production.up.railway.app/?verified=1")
                })
            except FirebaseError as error:
                print(f"Firebase verification email error: {error.code}")
            self.respond(403, {"error": "Confirma el enlace que enviamos a tu correo antes de iniciar sesión."})
            return

        firebase_id = firebase_user["localId"]
        con = db()
        profile = con.execute("SELECT * FROM firebase_pending_users WHERE firebase_id=?", (firebase_id,)).fetchone()
        existing = con.execute("SELECT * FROM users WHERE id=?", (firebase_id,)).fetchone()
        if not existing:
            name = profile["name"] if profile else email.split("@", 1)[0]
            district = profile["district"] if profile else ""
            con.execute(
                "INSERT INTO users(id,name,email,district,password_hash,verified,created_at) VALUES(?,?,?,?,?,?,?)",
                (firebase_id, name, email, district, "firebase-managed", 1, int(time.time()))
            )
        else:
            name = existing["name"]
            district = existing["district"]
        con.execute("DELETE FROM firebase_pending_users WHERE firebase_id=?", (firebase_id,))
        token = secrets.token_urlsafe(32)
        con.execute("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
                    (token, firebase_id, int(time.time()) + 60 * 60 * 24 * 30))
        con.commit()
        con.close()
        cookie = self.session_cookie(token, 60*60*24*30)
        self.respond(200, {"user": {"id": firebase_id, "name": name, "email": email, "district": district}}, cookie)

    def password_reset(self):
        email = str(self.json_body().get("email", "")).strip().lower()
        if len(email) > 254 or "@" not in email or "." not in email.rsplit("@", 1)[-1]:
            self.respond(400, {"error": "Escribe un correo electrónico válido."})
            return
        try:
            firebase_request("accounts:sendOobCode", {
                "requestType": "PASSWORD_RESET",
                "email": email
            })
        except FirebaseError as error:
            if error.code == "EMAIL_NOT_FOUND":
                pass
            elif error.code == "TOO_MANY_ATTEMPTS_TRY_LATER":
                self.respond(429, {"error": "Se solicitaron demasiados enlaces. Espera un momento e inténtalo de nuevo."})
                return
            else:
                print(f"Firebase password reset error: {error.code}")
                self.respond(*firebase_error_response(error.code))
                return
        self.respond(200, {
            "ok": True,
            "message": "Si el correo está registrado, recibirás un enlace para restablecer tu contraseña."
        })

    def logout(self):
        token = self.cookie_token()
        if token:
            con = db()
            con.execute("DELETE FROM sessions WHERE token=?", (token,))
            con.commit()
            con.close()
        self.respond(200, {"ok": True}, "encuentralab_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")

    def create_job(self):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Sesion requerida"})
            return
        data = self.json_body()
        if data.get("type") != "Rapido":
            self.respond(403, {"error": "Por ahora solo se pueden publicar trabajos rápidos."})
            return
        required = ("title", "type", "category", "city", "pay", "schedule", "description")
        if any(not str(data.get(field, "")).strip() for field in required):
            self.respond(400, {"error": "Completa todos los campos"})
            return
        district_key = str(data["city"]).strip().lower().replace("á","a").replace("é","e").replace("í","i").replace("ó","o").replace("ú","u")
        if district_key not in {d.replace("á","a").replace("é","e").replace("í","i").replace("ó","o").replace("ú","u") for d in LIMA_DISTRICTS}:
            self.respond(400, {"error": "El trabajo debe ser publicado en un distrito de Lima"})
            return
        try:
            applicant_limit = int(data.get("applicantLimit", MAX_APPLICANTS_PER_JOB))
        except (TypeError, ValueError):
            applicant_limit = 0
        if not 1 <= applicant_limit <= MAX_APPLICANTS_PER_JOB:
            self.respond(400, {"error": "El máximo debe estar entre 1 y 10 postulantes"})
            return
        job_id = secrets.token_urlsafe(12)
        con = db()
        con.execute(
            "INSERT INTO jobs(id,owner_id,owner_name,title,type,category,city,pay,schedule,description,status,applicant_limit,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, user["id"], user["name"], data["title"].strip(), data["type"], data["category"],
             data["city"].strip(), data["pay"].strip(), data["schedule"].strip(), data["description"].strip(),
             "Abierto", applicant_limit, int(time.time()))
        )
        con.commit()
        con.close()
        self.respond(201, {"id": job_id})

    def create_application(self):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Sesion requerida"})
            return
        data = self.json_body()
        job_id = str(data.get("jobId", ""))
        con = db()
        con.execute("BEGIN IMMEDIATE")
        job = con.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not job:
            con.close()
            self.respond(404, {"error": "El trabajo no existe"})
            return
        if job["owner_id"] == user["id"]:
            con.close()
            self.respond(403, {"error": "No puedes postularte a tu propio anuncio"})
            return
        profile = con.execute(
            "SELECT district FROM user_profiles WHERE user_id=? AND profile_type=?",
            (user["id"], job["type"])
        ).fetchone()
        if not profile or not profile["district"]:
            con.close()
            self.respond(409, {
                "error": "Completa tu perfil y selecciona tu distrito antes de postularte.",
                "code": "PROFILE_REQUIRED"
            })
            return
        if job["status"] != "Abierto":
            con.close()
            self.respond(409, {"error": "El trabajo ya no esta disponible"})
            return
        existing = con.execute(
            "SELECT 1 FROM applications WHERE job_id=? AND applicant_id=?", (job_id, user["id"])
        ).fetchone()
        if existing:
            con.close()
            self.respond(409, {"error": "Ya estas postulado a este trabajo"})
            return
        applicant_count = con.execute(
            "SELECT COUNT(*) FROM applications WHERE job_id=?", (job_id,)
        ).fetchone()[0]
        if applicant_count >= job["applicant_limit"]:
            con.close()
            self.respond(409, {
                "error": f"Este anuncio alcanzó el máximo de {job['applicant_limit']} postulantes.",
                "code": "MAX_APPLICANTS"
            })
            return
        application_id = secrets.token_urlsafe(12)
        conversation_id = f"{job_id}:{':'.join(sorted([job['owner_id'], user['id']]))}"
        con.execute(
            "INSERT INTO applications(id,job_id,applicant_id,applicant_name,status,created_at) VALUES(?,?,?,?,?,?)",
            (application_id, job_id, user["id"], user["name"], "Pendiente", int(time.time()))
        )
        con.execute(
            "INSERT INTO messages(id,conversation_id,sender_id,text,created_at) VALUES(?,?,?,?,?)",
            (secrets.token_urlsafe(12), conversation_id, user["id"],
             f"Hola, quiero postularme al trabajo: {job['title']}.", int(time.time()))
        )
        con.commit()
        con.close()
        self.respond(201, {"id": application_id, "conversationId": conversation_id})

    def delete_application(self, application_id):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Sesion requerida"})
            return
        if not application_id:
            self.respond(400, {"error": "Postulacion invalida"})
            return
        con = db()
        con.execute("BEGIN IMMEDIATE")
        application = con.execute(
            "SELECT job_id FROM applications WHERE id=?", (application_id,)
        ).fetchone()
        if not application:
            con.close()
            self.respond(404, {"error": "La postulacion ya no existe"})
            return
        job = con.execute(
            "SELECT owner_id FROM jobs WHERE id=?", (application["job_id"],)
        ).fetchone()
        if not job or job["owner_id"] != user["id"]:
            con.close()
            self.respond(403, {"error": "Solo quien publicó el anuncio puede quitar postulantes"})
            return
        con.execute("DELETE FROM applications WHERE id=?", (application_id,))
        con.commit()
        con.close()
        self.respond(200, {"ok": True})

    def delete_job(self, job_id):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Sesion requerida"})
            return
        if not job_id:
            self.respond(400, {"error": "Anuncio invalido"})
            return
        con = db()
        con.execute("BEGIN IMMEDIATE")
        job = con.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not job:
            con.close()
            self.respond(404, {"error": "El anuncio ya no existe"})
            return
        if job["owner_id"] != user["id"]:
            con.close()
            self.respond(403, {"error": "Solo quien publicó el anuncio puede borrarlo"})
            return
        has_applicants = con.execute("SELECT 1 FROM applications WHERE job_id=? LIMIT 1", (job_id,)).fetchone()
        if has_applicants:
            con.close()
            self.respond(409, {"error": "No se puede borrar un anuncio con postulantes. Puedes marcarlo como tomado."})
            return
        con.execute("DELETE FROM messages WHERE conversation_id LIKE ?", (f"{job_id}:%",))
        con.execute("DELETE FROM jobs WHERE id=? AND owner_id=?", (job_id, user["id"]))
        con.commit()
        con.close()
        self.respond(200, {"ok": True})

    def create_message(self):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Sesion requerida"})
            return
        data = self.json_body()
        conversation_id = str(data.get("conversationId", "")).strip()
        text = str(data.get("text", "")).strip()
        if not conversation_id or not text or len(text) > 2000:
            self.respond(400, {"error": "Mensaje invalido"})
            return
        parts = conversation_id.split(":")
        if len(parts) != 3 or not all(parts):
            self.respond(400, {"error": "Conversacion invalida"})
            return
        job_id, first_user_id, second_user_id = parts
        con = db()
        job = con.execute("SELECT id,owner_id FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not job:
            con.close()
            self.respond(404, {"error": "El trabajo de esta conversacion ya no existe"})
            return
        participants = sorted((first_user_id, second_user_id))
        if len(set(participants)) != 2 or user["id"] not in participants or job["owner_id"] not in participants:
            con.close()
            self.respond(403, {"error": "No tienes acceso a esta conversacion"})
            return
        peer_id = next(participant for participant in participants if participant != user["id"])
        if user["id"] == job["owner_id"]:
            has_application = con.execute(
                "SELECT 1 FROM applications WHERE job_id=? AND applicant_id=?",
                (job_id, peer_id)
            ).fetchone()
            has_conversation = con.execute(
                "SELECT 1 FROM messages WHERE conversation_id=? LIMIT 1",
                (conversation_id,)
            ).fetchone()
            if not has_application and not has_conversation:
                con.close()
                self.respond(403, {"error": "Solo puedes iniciar un chat con una persona postulada"})
                return
        con.execute(
            "INSERT INTO messages(id,conversation_id,sender_id,text,created_at) VALUES(?,?,?,?,?)",
            (secrets.token_urlsafe(12), conversation_id, user["id"], text, int(time.time()))
        )
        con.commit()
        con.close()
        self.respond(201, {"ok": True})

    def accept_job(self):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Sesion requerida"})
            return
        job_id = str(self.json_body().get("jobId", "")).strip()
        con = db()
        job = con.execute("SELECT * FROM jobs WHERE id=? AND owner_id=?", (job_id, user["id"])).fetchone()
        if not job:
            con.close()
            self.respond(404, {"error": "No puedes aceptar este trabajo"})
            return
        con.execute("UPDATE jobs SET status='Tomado' WHERE id=?", (job_id,))
        applicants = con.execute("SELECT * FROM applications WHERE job_id=?", (job_id,)).fetchall()
        for applicant in applicants:
            conversation_id = f"{job_id}:{':'.join(sorted([job['owner_id'], applicant['applicant_id']]))}"
            con.execute(
                "INSERT INTO messages(id,conversation_id,sender_id,text,created_at) VALUES(?,?,?,?,?)",
                (secrets.token_urlsafe(12), conversation_id, "system",
                 f"El trabajo \"{job['title']}\" ya fue tomado. Gracias por postularte.", int(time.time()))
            )
        con.commit()
        con.close()
        self.respond(200, {"ok": True})

    def log_message(self, format, *args):
        return

init_db()
ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
