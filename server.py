import hashlib
import os
import secrets
import smtplib
import sqlite3
import time
import urllib.request
from email.message import EmailMessage
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
import json

PORT = int(os.getenv("PORT", "4173"))
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
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    """)
    con.commit()
    con.close()

def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 240000)
    return f"{salt}${digest.hex()}"

def verify_password(password, stored):
    salt, expected = stored.split("$", 1)
    return secrets.compare_digest(hash_password(password, salt).split("$", 1)[1], expected)

def send_email(to_email, code):
    resend_key = os.getenv("RESEND_API_KEY")
    if resend_key:
        payload = json.dumps({
            "from": os.getenv("RESEND_FROM", "EncuentraLab <onboarding@resend.dev>"),
            "to": [to_email],
            "subject": "Codigo de verificacion - EncuentraLab",
            "html": f"""
              <h2>Verifica tu cuenta</h2>
              <p>Tu codigo de EncuentraLab es:</p>
              <h1 style="letter-spacing:6px">{code}</h1>
              <p>Caduca en 10 minutos.</p>
            """
        }).encode()
        request = urllib.request.Request(
            "https://api.resend.com/emails",
            data=payload,
            headers={
                "Authorization": f"Bearer {resend_key}",
                "Content-Type": "application/json"
            },
            method="POST"
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status >= 300:
                raise RuntimeError("Resend rechazo el envio")
        return True
    host = os.getenv("SMTP_HOST")
    if not host:
        print(f"[VERIFICACIÓN DEMO] {to_email}: {code}")
        return False
    port = int(os.getenv("SMTP_PORT", "587"))
    message = EmailMessage()
    message["Subject"] = "Código de verificación - EncuentraLab"
    message["From"] = os.getenv("SMTP_FROM", "no-reply@encuentralab.pe")
    message["To"] = to_email
    message.set_content(
        f"Tu código de verificación de EncuentraLab es: {code}\n\n"
        "Caduca en 10 minutos. Si no solicitaste esta cuenta, ignora este mensaje."
    )
    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.starttls()
        smtp.login(os.getenv("SMTP_USER"), os.getenv("SMTP_PASSWORD"))
        smtp.send_message(message)
    return True

class Handler(SimpleHTTPRequestHandler):
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

    def do_GET(self):
        if self.path == "/api/session":
            user = self.current_user()
            self.respond(200 if user else 401, {"user": user})
            return
        if self.path == "/api/jobs":
            con = db()
            rows = con.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchall()
            con.close()
            self.respond(200, {"jobs": [dict(row) for row in rows]})
            return
        if self.path == "/api/applications":
            user = self.current_user()
            if not user:
                self.respond(401, {"error": "Sesion requerida"})
                return
            con = db()
            rows = con.execute(
                "SELECT * FROM applications WHERE applicant_id=? "
                "UNION SELECT * FROM applications WHERE job_id IN "
                "(SELECT id FROM jobs WHERE owner_id=?)",
                (user["id"], user["id"])
            ).fetchall()
            con.close()
            self.respond(200, {"applications": [dict(row) for row in rows]})
            return
        if self.path == "/api/messages":
            user = self.current_user()
            if not user:
                self.respond(401, {"error": "Sesion requerida"})
                return
            con = db()
            rows = con.execute(
                "SELECT m.* FROM messages m "
                "JOIN jobs j ON j.id=substr(m.conversation_id,1,instr(m.conversation_id,':')-1) "
                "LEFT JOIN applications a ON a.job_id=j.id "
                "WHERE j.owner_id=? OR a.applicant_id=? "
                "GROUP BY m.id ORDER BY m.created_at ASC",
                (user["id"], user["id"])
            ).fetchall()
            con.close()
            self.respond(200, {"messages": [dict(row) for row in rows]})
            return
        if self.path.startswith("/api/"):
            self.respond(404, {"error": "Ruta no encontrada"})
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/register":
            self.register()
        elif self.path == "/api/verify":
            self.verify()
        elif self.path == "/api/login":
            self.login()
        elif self.path == "/api/logout":
            self.logout()
        elif self.path == "/api/jobs":
            self.create_job()
        elif self.path == "/api/applications":
            self.create_application()
        elif self.path == "/api/messages":
            self.create_message()
        elif self.path == "/api/jobs/accept":
            self.accept_job()
        else:
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
        if len(password) < 10 or not any(c.isupper() for c in password) or not any(c.isdigit() for c in password):
            self.respond(400, {"error": "La contraseña debe tener 10 caracteres, una mayúscula y un número"})
            return
        if district_key not in LIMA_DISTRICTS:
            self.respond(400, {"error": "Selecciona un distrito de Lima"})
            return
        con = db()
        if con.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            con.close()
            self.respond(409, {"error": "Ya existe una cuenta con este correo"})
            return
        code = f"{secrets.randbelow(900000)+100000}"
        pending = json.dumps({"name": name, "email": email, "district": district, "password_hash": hash_password(password)}, ensure_ascii=False)
        con.execute(
            "INSERT OR REPLACE INTO verification_codes(email,code_hash,expires_at,pending_json) VALUES(?,?,?,?)",
            (email, hashlib.sha256(code.encode()).hexdigest(), int(time.time()) + 600, pending)
        )
        con.commit()
        con.close()
        sent = send_email(email, code)
        response = {"pending": True, "delivery": "email" if sent else "demo"}
        if not sent:
            response["demo_code"] = code
        self.respond(200, response)

    def verify(self):
        data = self.json_body()
        email = str(data.get("email", "")).strip().lower()
        code = str(data.get("code", "")).strip()
        con = db()
        row = con.execute("SELECT * FROM verification_codes WHERE email=?", (email,)).fetchone()
        if not row or row["expires_at"] < int(time.time()) or not secrets.compare_digest(row["code_hash"], hashlib.sha256(code.encode()).hexdigest()):
            con.close()
            self.respond(400, {"error": "Código incorrecto o vencido"})
            return
        pending = json.loads(row["pending_json"])
        user_id = secrets.token_urlsafe(18)
        con.execute(
            "INSERT INTO users(id,name,email,district,password_hash,verified,created_at) VALUES(?,?,?,?,?,1,?)",
            (user_id, pending["name"], pending["email"], pending["district"], pending["password_hash"], int(time.time()))
        )
        con.execute("DELETE FROM verification_codes WHERE email=?", (email,))
        token = secrets.token_urlsafe(32)
        con.execute("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
                    (token, user_id, int(time.time()) + 60 * 60 * 24 * 30))
        con.commit()
        con.close()
        cookie = self.session_cookie(token, 60*60*24*30)
        self.respond(200, {"user": {"id": user_id, "name": pending["name"], "email": email, "district": pending["district"]}}, cookie)

    def login(self):
        data = self.json_body()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        con = db()
        row = con.execute("SELECT * FROM users WHERE email=? AND verified=1", (email,)).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            con.close()
            time.sleep(0.25)
            self.respond(401, {"error": "Correo o contraseña incorrectos"})
            return
        token = secrets.token_urlsafe(32)
        con.execute("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
                    (token, row["id"], int(time.time()) + 60 * 60 * 24 * 30))
        con.commit()
        con.close()
        cookie = self.session_cookie(token, 60*60*24*30)
        self.respond(200, {"user": {"id": row["id"], "name": row["name"], "email": row["email"], "district": row["district"]}}, cookie)

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
        required = ("title", "type", "category", "city", "pay", "schedule", "description")
        if any(not str(data.get(field, "")).strip() for field in required):
            self.respond(400, {"error": "Completa todos los campos"})
            return
        district_key = str(data["city"]).strip().lower().replace("á","a").replace("é","e").replace("í","i").replace("ó","o").replace("ú","u")
        if district_key not in {d.replace("á","a").replace("é","e").replace("í","i").replace("ó","o").replace("ú","u") for d in LIMA_DISTRICTS}:
            self.respond(400, {"error": "El trabajo debe ser publicado en un distrito de Lima"})
            return
        job_id = secrets.token_urlsafe(12)
        con = db()
        con.execute(
            "INSERT INTO jobs(id,owner_id,owner_name,title,type,category,city,pay,schedule,description,status,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, user["id"], user["name"], data["title"].strip(), data["type"], data["category"],
             data["city"].strip(), data["pay"].strip(), data["schedule"].strip(), data["description"].strip(),
             "Abierto", int(time.time()))
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
        job = con.execute("SELECT * FROM jobs WHERE id=? AND status='Abierto'", (job_id,)).fetchone()
        if not job:
            con.close()
            self.respond(404, {"error": "El trabajo ya no esta disponible"})
            return
        existing = con.execute(
            "SELECT 1 FROM applications WHERE job_id=? AND applicant_id=?", (job_id, user["id"])
        ).fetchone()
        if existing:
            con.close()
            self.respond(409, {"error": "Ya estas postulado a este trabajo"})
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

    def create_message(self):
        user = self.current_user()
        if not user:
            self.respond(401, {"error": "Sesion requerida"})
            return
        data = self.json_body()
        conversation_id = str(data.get("conversationId", "")).strip()
        text = str(data.get("text", "")).strip()
        if not conversation_id or not text:
            self.respond(400, {"error": "Mensaje invalido"})
            return
        con = db()
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
