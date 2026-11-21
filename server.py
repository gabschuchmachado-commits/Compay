import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import time
from datetime import datetime, timezone
from getpass import getpass
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


ROOT = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("COMPAY_DATABASE", ROOT / "compay.sqlite3"))
HOST = os.environ.get("COMPAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("COMPAY_PORT", "8000"))
COOKIE_NAME = "compay_session"
SESSION_SECONDS = 60 * 60 * 24 * 14
PBKDF2_ITERATIONS = 600_000
RATE_LIMIT = {}
CATEGORIES = {
    "Moda e acessórios", "Casa e decoração", "Beleza e cuidados", "Eletrônicos",
    "Artesanato", "Brinquedos e hobbies", "Livros e papelaria", "Hortifruti",
    "Mercearia", "Laticínios", "Padaria", "Bebidas", "Outros",
}
ORDER_STATUSES = {"Recebido", "Em preparo", "Pronto para retirada", "Concluído", "Cancelado"}


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


def connect_db():
    connection = sqlite3.connect(DATABASE, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    return connection


@contextmanager
def database():
    connection = connect_db()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_db():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    with database() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                csrf_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stores (
                id TEXT PRIMARY KEY,
                owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                location TEXT NOT NULL DEFAULT '',
                image TEXT NOT NULL DEFAULT '',
                approved INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                unit TEXT NOT NULL,
                price REAL NOT NULL CHECK (price > 0),
                old_price REAL,
                description TEXT NOT NULL DEFAULT '',
                image TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
                buyer_id INTEGER NOT NULL REFERENCES users(id),
                status TEXT NOT NULL DEFAULT 'Recebido',
                total REAL NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY,
                order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                product_id TEXT NOT NULL,
                name TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                unit_price REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reviews (
                id INTEGER PRIMARY KEY,
                store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
                comment TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE(store_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS stores_approved_idx ON stores(approved);
            CREATE INDEX IF NOT EXISTS products_store_active_idx ON products(store_id, active);
            CREATE INDEX IF NOT EXISTS orders_store_created_idx ON orders(store_id, created_at);
            """
        )


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hash_password(password):
    salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(derived).decode("ascii"),
    )


def verify_password(password, encoded):
    try:
        algorithm, iterations, salt_text, expected_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_text.encode("ascii"))
        expected = base64.urlsafe_b64decode(expected_text.encode("ascii"))
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def user_data(row):
    if row is None:
        return None
    return {"id": row["id"], "name": row["name"], "email": row["email"], "role": row["role"]}


def valid_image(value):
    value = str(value or "").strip()
    if not value:
        return ""
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise APIError(400, "A imagem precisa usar um endereço http ou https válido.")
    return value[:1000]


def required_text(value, label, maximum):
    text = str(value or "").strip()
    if not text:
        raise APIError(400, f"Preencha o campo {label}.")
    if len(text) > maximum:
        raise APIError(400, f"O campo {label} excede o limite de {maximum} caracteres.")
    return text


def get_store(db, store_id):
    return db.execute(
        """
        SELECT s.*, u.name AS owner_name,
               COALESCE((SELECT SUM(oi.quantity) FROM orders o
                         JOIN order_items oi ON oi.order_id = o.id
                         WHERE o.store_id = s.id AND o.status != 'Cancelado'), 0) AS sold_count,
               COALESCE((SELECT AVG(r.rating) FROM reviews r WHERE r.store_id = s.id), 0) AS average_rating,
               (SELECT COUNT(*) FROM reviews r WHERE r.store_id = s.id) AS review_count
        FROM stores s JOIN users u ON u.id = s.owner_id WHERE s.id = ?
        """,
        (store_id,),
    ).fetchone()


def store_data(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "description": row["description"],
        "location": row["location"],
        "image": row["image"],
        "approved": bool(row["approved"]),
        "ownerName": row["owner_name"],
        "soldCount": int(row["sold_count"] or 0),
        "averageRating": round(float(row["average_rating"] or 0), 1),
        "reviewCount": int(row["review_count"] or 0),
    }


def product_data(row):
    return {
        "id": row["id"],
        "shopId": row["store_id"],
        "name": row["name"],
        "category": row["category"],
        "unit": row["unit"],
        "price": row["price"],
        "oldPrice": row["old_price"],
        "description": row["description"],
        "image": row["image"],
    }


class ComPayHandler(BaseHTTPRequestHandler):
    server_version = "ComPay/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def send_json(self, status, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_security_headers()
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' https: data:; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; "
            "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
        )

    def send_error_json(self, status, message):
        self.send_json(status, {"error": message})

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise APIError(400, "Tamanho de solicitação inválido.")
        if length < 1 or length > 1_000_000:
            raise APIError(400, "Envie um corpo JSON de até 1 MB.")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise APIError(400, "O corpo da solicitação não contém JSON válido.")
        if not isinstance(value, dict):
            raise APIError(400, "O corpo deve ser um objeto JSON.")
        return value

    def current_session(self, db):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return None, None
        morsel = cookie.get(COOKIE_NAME)
        if morsel is None:
            return None, None
        token = morsel.value
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        row = db.execute(
            """
            SELECT s.csrf_token, u.id, u.name, u.email, u.role
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?
            """,
            (token_hash, int(time.time())),
        ).fetchone()
        return (row, token_hash) if row else (None, token_hash)

    def require_user(self, db):
        session, _ = self.current_session(db)
        if session is None:
            raise APIError(401, "Entre na sua conta para continuar.")
        return session

    def require_csrf(self, session):
        supplied = self.headers.get("X-CSRF-Token", "")
        if not supplied or not hmac.compare_digest(supplied, session["csrf_token"]):
            raise APIError(403, "Sessão expirada ou token de segurança inválido. Atualize a página.")

    def require_store_manager(self, db, session, store_id):
        store = db.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
        if store is None:
            raise APIError(404, "Loja não encontrada.")
        if session["role"] != "admin" and store["owner_id"] != session["id"]:
            raise APIError(403, "Você só pode gerenciar suas próprias lojas.")
        return store

    def create_session(self, db, user_id):
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        expires = int(time.time()) + SESSION_SECONDS
        db.execute(
            "INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (token_hash, user_id, csrf, expires, now_iso()),
        )
        return token, csrf

    def cookie_header(self, token, max_age=SESSION_SECONDS):
        secure = "; Secure" if os.environ.get("COMPAY_SECURE_COOKIE") == "1" else ""
        return f"{COOKIE_NAME}={token}; HttpOnly; Path=/; SameSite=Lax; Max-Age={max_age}{secure}"

    def do_GET(self):
        parsed = urlsplit(self.path)
        if not parsed.path.startswith("/api/"):
            self.serve_static(parsed.path)
            return
        try:
            with database() as db:
                status, payload = self.api_get(db, parsed.path, parse_qs(parsed.query))
            self.send_json(status, payload)
        except APIError as error:
            self.send_error_json(error.status, error.message)
        except sqlite3.Error:
            self.send_error_json(500, "Ocorreu um erro ao consultar os dados.")

    def do_POST(self):
        self.dispatch_write("POST")

    def do_PATCH(self):
        self.dispatch_write("PATCH")

    def do_DELETE(self):
        self.dispatch_write("DELETE")

    def dispatch_write(self, method):
        parsed = urlsplit(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error_json(404, "Rota não encontrada.")
            return
        try:
            with database() as db:
                result = self.api_write(db, method, parsed.path)
                if len(result) == 2:
                    status, payload = result
                    headers = {}
                else:
                    status, payload, headers = result
            self.send_json(status, payload, headers)
        except APIError as error:
            self.send_error_json(error.status, error.message)
        except sqlite3.IntegrityError:
            self.send_error_json(409, "Não foi possível salvar: o registro já existe ou está sendo usado.")
        except sqlite3.Error:
            self.send_error_json(500, "Ocorreu um erro ao salvar os dados.")

    def api_get(self, db, path, query):
        if path == "/api/me":
            session, _ = self.current_session(db)
            return 200, {
                "user": user_data(session),
                "csrfToken": session["csrf_token"] if session else None,
            }

        if path == "/api/stores":
            search = query.get("search", [""])[0].strip()
            rows = db.execute(
                """
                SELECT s.*, u.name AS owner_name,
                       COALESCE((SELECT SUM(oi.quantity) FROM orders o
                                 JOIN order_items oi ON oi.order_id = o.id
                                 WHERE o.store_id = s.id AND o.status != 'Cancelado'), 0) AS sold_count,
                       COALESCE((SELECT AVG(r.rating) FROM reviews r WHERE r.store_id = s.id), 0) AS average_rating,
                       (SELECT COUNT(*) FROM reviews r WHERE r.store_id = s.id) AS review_count
                FROM stores s JOIN users u ON u.id = s.owner_id
                WHERE s.approved = 1 AND (
                    ? = '' OR s.name LIKE ? OR s.category LIKE ? OR s.description LIKE ?
                )
                ORDER BY sold_count DESC, average_rating DESC, s.created_at DESC
                """,
                (search, f"%{search}%", f"%{search}%", f"%{search}%"),
            ).fetchall()
            return 200, {"stores": [store_data(row) for row in rows]}

        if path == "/api/products":
            search = query.get("search", [""])[0].strip()
            category = query.get("category", [""])[0].strip()
            store_id = query.get("store", [""])[0].strip()
            rows = db.execute(
                """
                SELECT p.* FROM products p JOIN stores s ON s.id = p.store_id
                WHERE p.active = 1 AND s.approved = 1
                  AND (? = '' OR p.name LIKE ? OR p.category LIKE ? OR p.description LIKE ?)
                  AND (? = '' OR p.category = ?)
                  AND (? = '' OR p.store_id = ?)
                ORDER BY p.created_at DESC
                """,
                (
                    search, f"%{search}%", f"%{search}%", f"%{search}%",
                    category, category, store_id, store_id,
                ),
            ).fetchall()
            return 200, {"products": [product_data(row) for row in rows]}

        if path == "/api/seller/stores":
            session = self.require_user(db)
            rows = db.execute(
                """
                SELECT s.*, u.name AS owner_name,
                       COALESCE((SELECT SUM(oi.quantity) FROM orders o
                                 JOIN order_items oi ON oi.order_id = o.id
                                 WHERE o.store_id = s.id AND o.status != 'Cancelado'), 0) AS sold_count,
                       COALESCE((SELECT AVG(r.rating) FROM reviews r WHERE r.store_id = s.id), 0) AS average_rating,
                       (SELECT COUNT(*) FROM reviews r WHERE r.store_id = s.id) AS review_count
                FROM stores s JOIN users u ON u.id = s.owner_id
                WHERE s.owner_id = ? ORDER BY s.created_at DESC
                """,
                (session["id"],),
            ).fetchall()
            return 200, {"stores": [store_data(row) for row in rows]}

        if path == "/api/admin/stores":
            session = self.require_user(db)
            if session["role"] != "admin":
                raise APIError(403, "Apenas o administrador pode acessar esta área.")
            rows = db.execute(
                """
                SELECT s.*, u.name AS owner_name,
                       COALESCE((SELECT SUM(oi.quantity) FROM orders o
                                 JOIN order_items oi ON oi.order_id = o.id
                                 WHERE o.store_id = s.id AND o.status != 'Cancelado'), 0) AS sold_count,
                       COALESCE((SELECT AVG(r.rating) FROM reviews r WHERE r.store_id = s.id), 0) AS average_rating,
                       (SELECT COUNT(*) FROM reviews r WHERE r.store_id = s.id) AS review_count
                FROM stores s JOIN users u ON u.id = s.owner_id ORDER BY s.approved, s.created_at DESC
                """
            ).fetchall()
            return 200, {"stores": [store_data(row) for row in rows]}

        match = re.fullmatch(r"/api/stores/([^/]+)(?:/(products|reviews|orders))?", path)
        if match:
            store_id = unquote(match.group(1))
            resource = match.group(2)
            store = get_store(db, store_id)
            if store is None:
                raise APIError(404, "Loja não encontrada.")
            session, _ = self.current_session(db)
            is_manager = session and (session["role"] == "admin" or session["id"] == store["owner_id"])
            if not store["approved"] and not is_manager:
                raise APIError(404, "Loja não encontrada.")
            if resource is None:
                return 200, {"store": store_data(store)}
            if resource == "products":
                rows = db.execute(
                    "SELECT * FROM products WHERE store_id = ? AND active = 1 ORDER BY created_at DESC",
                    (store_id,),
                ).fetchall()
                return 200, {"products": [product_data(row) for row in rows]}
            if resource == "reviews":
                rows = db.execute(
                    """
                    SELECT r.id, r.rating, r.comment, r.created_at, u.name AS author
                    FROM reviews r JOIN users u ON u.id = r.user_id
                    WHERE r.store_id = ? ORDER BY r.created_at DESC
                    """,
                    (store_id,),
                ).fetchall()
                can_review = False
                my_review = None
                if session:
                    my_review = db.execute(
                        "SELECT id, rating, comment FROM reviews WHERE store_id = ? AND user_id = ?",
                        (store_id, session["id"]),
                    ).fetchone()
                    bought = db.execute(
                        "SELECT 1 FROM orders WHERE store_id = ? AND buyer_id = ? AND status != 'Cancelado' LIMIT 1",
                        (store_id, session["id"]),
                    ).fetchone()
                    can_review = bool(bought and session["id"] != store["owner_id"])
                return 200, {
                    "reviews": [
                        {
                            "id": row["id"],
                            "rating": row["rating"],
                            "comment": row["comment"],
                            "createdAt": row["created_at"],
                            "author": row["author"],
                        }
                        for row in rows
                    ],
                    "canReview": can_review,
                    "myReview": dict(my_review) if my_review else None,
                    "loggedIn": session is not None,
                }
            if resource == "orders":
                if session is None:
                    raise APIError(401, "Entre na sua conta para acessar os pedidos.")
                self.require_store_manager(db, session, store_id)
                rows = db.execute(
                    """
                    SELECT o.id, o.status, o.total, o.created_at, u.name AS buyer_name,
                           (SELECT json_group_array(json_object(
                               'name', i.name, 'quantity', i.quantity, 'unitPrice', i.unit_price
                           )) FROM order_items i WHERE i.order_id = o.id) AS items
                    FROM orders o JOIN users u ON u.id = o.buyer_id
                    WHERE o.store_id = ? ORDER BY o.created_at DESC
                    """,
                    (store_id,),
                ).fetchall()
                return 200, {
                    "orders": [
                        {
                            "id": row["id"],
                            "status": row["status"],
                            "total": row["total"],
                            "createdAt": row["created_at"],
                            "buyerName": row["buyer_name"],
                            "items": json.loads(row["items"] or "[]"),
                        }
                        for row in rows
                    ]
                }

        raise APIError(404, "Rota não encontrada.")

    def api_write(self, db, method, path):
        if method == "POST" and path in {"/api/auth/register", "/api/auth/login"}:
            payload = self.read_json()
            email = str(payload.get("email", "")).strip().lower()
            password = str(payload.get("password", ""))
            if len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
                raise APIError(400, "Informe um e-mail válido.")
            if path.endswith("/register"):
                name = required_text(payload.get("name"), "nome", 80)
                if len(password) < 12:
                    raise APIError(400, "A senha deve ter pelo menos 12 caracteres.")
                if len(password) > 256:
                    raise APIError(400, "A senha excede o tamanho permitido.")
                try:
                    with db:
                        cursor = db.execute(
                            "INSERT INTO users(name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'member', ?)",
                            (name, email, hash_password(password), now_iso()),
                        )
                except sqlite3.IntegrityError:
                    raise APIError(409, "Já existe uma conta com este e-mail.")
                user_id = cursor.lastrowid
            else:
                ip = self.client_address[0]
                attempts, reset_at = RATE_LIMIT.get(ip, (0, 0))
                if time.time() < reset_at and attempts >= 8:
                    raise APIError(429, "Muitas tentativas. Aguarde 15 minutos e tente novamente.")
                row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
                if row is None or not verify_password(password, row["password_hash"]):
                    if time.time() >= reset_at:
                        attempts, reset_at = 0, time.time() + 900
                    RATE_LIMIT[ip] = (attempts + 1, reset_at)
                    raise APIError(401, "E-mail ou senha incorretos.")
                RATE_LIMIT.pop(ip, None)
                user_id = row["id"]
            token, csrf = self.create_session(db, user_id)
            user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            return 201 if path.endswith("/register") else 200, {
                "user": user_data(user),
                "csrfToken": csrf,
            }, {"Set-Cookie": self.cookie_header(token)}

        if method == "POST" and path == "/api/auth/logout":
            session = self.require_user(db)
            self.require_csrf(session)
            _, token_hash = self.current_session(db)
            with db:
                db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            return 200, {"ok": True}, {"Set-Cookie": self.cookie_header("", 0)}

        session = self.require_user(db)
        self.require_csrf(session)
        payload = self.read_json() if method in {"POST", "PATCH"} else {}

        if method == "POST" and path == "/api/stores":
            name = required_text(payload.get("name"), "nome da loja", 60)
            category = required_text(payload.get("category"), "categoria", 40)
            if category not in CATEGORIES:
                raise APIError(400, "Escolha uma categoria disponível.")
            description = str(payload.get("description", "")).strip()[:300]
            location = str(payload.get("location", "")).strip()[:100]
            image = valid_image(payload.get("image"))
            store_id = secrets.token_urlsafe(12)
            with db:
                db.execute(
                    """
                    INSERT INTO stores(id, owner_id, name, category, description, location, image, approved, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
                    """,
                    (store_id, session["id"], name, category, description, location, image, now_iso()),
                )
            return 201, {"store": store_data(get_store(db, store_id))}

        match = re.fullmatch(r"/api/stores/([^/]+)", path)
        if method == "PATCH" and match:
            store_id = unquote(match.group(1))
            store = self.require_store_manager(db, session, store_id)
            updates = {}
            for key, column, max_length in (
                ("name", "name", 60),
                ("category", "category", 40),
                ("description", "description", 300),
                ("location", "location", 100),
            ):
                if key in payload:
                    value = str(payload[key]).strip()
                    if key in {"name", "category"} and not value:
                        raise APIError(400, f"Preencha o campo {key}.")
                    if len(value) > max_length:
                        raise APIError(400, f"O campo {key} excede {max_length} caracteres.")
                    if key == "category" and value not in CATEGORIES:
                        raise APIError(400, "Escolha uma categoria disponível.")
                    updates[column] = value
            if "image" in payload:
                updates["image"] = valid_image(payload["image"])
            if not updates:
                raise APIError(400, "Nenhuma alteração foi enviada.")
            with db:
                db.execute(
                    "UPDATE stores SET " + ", ".join(f"{key} = ?" for key in updates) + " WHERE id = ?",
                    (*updates.values(), store_id),
                )
            return 200, {"store": store_data(get_store(db, store_id))}

        match = re.fullmatch(r"/api/stores/([^/]+)/products", path)
        if method == "POST" and match:
            store_id = unquote(match.group(1))
            self.require_store_manager(db, session, store_id)
            name = required_text(payload.get("name"), "nome do produto", 80)
            category = required_text(payload.get("category"), "categoria", 40)
            unit = required_text(payload.get("unit"), "unidade", 40)
            if category not in CATEGORIES:
                raise APIError(400, "Escolha uma categoria disponível.")
            try:
                price = round(float(payload.get("price")), 2)
                old_price = payload.get("oldPrice")
                old_price = round(float(old_price), 2) if old_price not in (None, "") else None
            except (TypeError, ValueError):
                raise APIError(400, "Informe preços numéricos válidos.")
            if not 0 < price <= 999999 or (old_price is not None and not price < old_price <= 999999):
                raise APIError(400, "O preço anterior, se informado, precisa ser maior que o preço atual.")
            product_id = secrets.token_urlsafe(12)
            image = valid_image(payload.get("image"))
            description = str(payload.get("description", "")).strip()[:300]
            with db:
                db.execute(
                    """
                    INSERT INTO products(id, store_id, name, category, unit, price, old_price, description, image, active, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                    """,
                    (product_id, store_id, name, category, unit, price, old_price, description, image, now_iso()),
                )
            row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
            return 201, {"product": product_data(row)}

        match = re.fullmatch(r"/api/stores/([^/]+)/reviews", path)
        if method == "POST" and match:
            store_id = unquote(match.group(1))
            store = db.execute("SELECT * FROM stores WHERE id = ? AND approved = 1", (store_id,)).fetchone()
            if store is None:
                raise APIError(404, "Loja não encontrada.")
            if store["owner_id"] == session["id"]:
                raise APIError(403, "Você não pode avaliar sua própria loja.")
            try:
                rating = int(payload.get("rating"))
            except (TypeError, ValueError):
                raise APIError(400, "Escolha uma nota de 1 a 5.")
            if rating < 1 or rating > 5:
                raise APIError(400, "A nota deve ficar entre 1 e 5.")
            comment = str(payload.get("comment", "")).strip()[:500]
            purchased = db.execute(
                "SELECT 1 FROM orders WHERE store_id = ? AND buyer_id = ? AND status != 'Cancelado' LIMIT 1",
                (store_id, session["id"]),
            ).fetchone()
            if not purchased:
                raise APIError(403, "Só é possível avaliar uma loja depois de fazer um pedido.")
            with db:
                db.execute(
                    """
                    INSERT INTO reviews(store_id, user_id, rating, comment, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(store_id, user_id) DO UPDATE SET
                        rating = excluded.rating, comment = excluded.comment, created_at = excluded.created_at
                    """,
                    (store_id, session["id"], rating, comment, now_iso()),
                )
            return 201, {"ok": True}

        if method == "POST" and path == "/api/orders":
            entries = payload.get("items")
            if not isinstance(entries, list) or not entries or len(entries) > 100:
                raise APIError(400, "Adicione pelo menos um produto à sacola.")
            grouped = {}
            for entry in entries:
                if not isinstance(entry, dict):
                    raise APIError(400, "Um dos itens do pedido é inválido.")
                product_id = str(entry.get("productId", ""))
                try:
                    quantity = int(entry.get("quantity"))
                except (TypeError, ValueError):
                    raise APIError(400, "A quantidade de um produto é inválida.")
                if quantity < 1 or quantity > 99:
                    raise APIError(400, "Cada produto deve ter entre 1 e 99 unidades.")
                product = db.execute(
                    """
                    SELECT p.*, s.name AS store_name FROM products p
                    JOIN stores s ON s.id = p.store_id
                    WHERE p.id = ? AND p.active = 1 AND s.approved = 1
                    """,
                    (product_id,),
                ).fetchone()
                if product is None:
                    raise APIError(400, "Um produto não está mais disponível.")
                grouped.setdefault(product["store_id"], []).append((product, quantity))
            created = []
            with db:
                for store_id, lines in grouped.items():
                    if db.execute("SELECT owner_id FROM stores WHERE id = ?", (store_id,)).fetchone()["owner_id"] == session["id"]:
                        raise APIError(400, "Não é possível fazer um pedido na sua própria loja.")
                    order_id = secrets.token_urlsafe(12)
                    total = round(sum(float(product["price"]) * quantity for product, quantity in lines), 2)
                    db.execute(
                        "INSERT INTO orders(id, store_id, buyer_id, status, total, created_at) VALUES (?, ?, ?, 'Recebido', ?, ?)",
                        (order_id, store_id, session["id"], total, now_iso()),
                    )
                    for product, quantity in lines:
                        db.execute(
                            "INSERT INTO order_items(order_id, product_id, name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)",
                            (order_id, product["id"], product["name"], quantity, product["price"]),
                        )
                    created.append({"id": order_id, "storeId": store_id, "storeName": lines[0][0]["store_name"], "total": total})
            return 201, {"orders": created}

        match = re.fullmatch(r"/api/orders/([^/]+)", path)
        if method == "PATCH" and match:
            order_id = unquote(match.group(1))
            order = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
            if order is None:
                raise APIError(404, "Pedido não encontrado.")
            self.require_store_manager(db, session, order["store_id"])
            status = str(payload.get("status", ""))
            if status not in ORDER_STATUSES:
                raise APIError(400, "Status de pedido inválido.")
            with db:
                db.execute("UPDATE orders SET status = ? WHERE id = ?", (status, order_id))
            return 200, {"ok": True}

        match = re.fullmatch(r"/api/admin/stores/([^/]+)", path)
        if match and method in {"PATCH", "DELETE"}:
            if session["role"] != "admin":
                raise APIError(403, "Apenas o administrador pode moderar lojas.")
            store_id = unquote(match.group(1))
            if db.execute("SELECT 1 FROM stores WHERE id = ?", (store_id,)).fetchone() is None:
                raise APIError(404, "Loja não encontrada.")
            with db:
                if method == "DELETE":
                    db.execute("DELETE FROM stores WHERE id = ?", (store_id,))
                    return 200, {"ok": True}
                if not isinstance(payload.get("approved"), bool):
                    raise APIError(400, "Informe se a loja deve ser aprovada.")
                db.execute("UPDATE stores SET approved = ? WHERE id = ?", (int(payload["approved"]), store_id))
            return 200, {"store": store_data(get_store(db, store_id))}

        match = re.fullmatch(r"/api/stores/([^/]+)/products/([^/]+)", path)
        if match and method == "DELETE":
            store_id, product_id = map(unquote, match.groups())
            self.require_store_manager(db, session, store_id)
            with db:
                cursor = db.execute("DELETE FROM products WHERE id = ? AND store_id = ?", (product_id, store_id))
            if cursor.rowcount == 0:
                raise APIError(404, "Produto não encontrado.")
            return 200, {"ok": True}

        raise APIError(404, "Rota não encontrada.")

    def serve_static(self, requested_path):
        requested_path = unquote(requested_path)
        if requested_path in {"/", "/index.html"}:
            requested_path = "/teste.html"
        filename = requested_path.lstrip("/")
        if filename not in {"teste.html", "teste.css", "teste.js"}:
            self.send_error(404)
            return
        file_path = ROOT / filename
        try:
            content = file_path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if filename.endswith(".js"):
            content_type = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(content)


def create_admin(email):
    initialize_db()
    email = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise SystemExit("Informe um e-mail válido.")
    password = getpass("Senha do administrador (mínimo 12 caracteres): ")
    confirmation = getpass("Confirme a senha: ")
    if len(password) < 12:
        raise SystemExit("A senha precisa ter pelo menos 12 caracteres.")
    if not hmac.compare_digest(password, confirmation):
        raise SystemExit("As senhas não conferem.")
    name = input("Nome do administrador: ").strip() or "Administrador Com Pay"
    with database() as db:
        existing = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if existing:
            db.execute(
                "UPDATE users SET name = ?, password_hash = ?, role = 'admin' WHERE id = ?",
                (name, hash_password(password), existing["id"]),
            )
        else:
            db.execute(
                "INSERT INTO users(name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
                (name, email, hash_password(password), now_iso()),
            )
    print(f"Administrador configurado para {email}.")


def run_server():
    initialize_db()
    server = ThreadingHTTPServer((HOST, PORT), ComPayHandler)
    server.daemon_threads = True
    print(f"Com Pay disponível em http://{HOST}:{PORT}")
    print(f"Banco de dados: {DATABASE}")
    print("Use Ctrl+C para encerrar.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "create-admin":
        if len(sys.argv) != 3:
            raise SystemExit("Uso: py server.py create-admin email@exemplo.com")
        create_admin(sys.argv[2])
    else:
        run_server()
