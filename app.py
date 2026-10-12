from flask import Flask, render_template, jsonify, request, session, g, redirect, url_for, abort
from datetime import timedelta
from functools import wraps
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
import uuid

app = Flask(__name__)
app.json.sort_keys = False  # keep branch/file creation order in responses

os.makedirs(app.instance_path, exist_ok=True)
DB_PATH = os.path.join(app.instance_path, "gitsim.db")
GUEST_RETENTION_DAYS = 30


def load_secret_key():
    """ Use SECRET_KEY from the environment, otherwise a key persisted in instance/ so sessions survive restarts """
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    key_file = os.path.join(app.instance_path, "secret_key")
    if not os.path.exists(key_file):
        with open(key_file, "w") as f:
            f.write(secrets.token_hex(32))
    with open(key_file) as f:
        return f.read().strip()


app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=GUEST_RETENTION_DAYS),
)

BRANCH_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
CONFLICT_MARKER_RE = re.compile(r"^(<{7}|={7}|>{7})", re.MULTILINE)


# ---------- sign in with Google / GitHub (enabled per provider via environment variables) ----------

try:
    from authlib.integrations.flask_client import OAuth
except ImportError:  # sign-in stays disabled, guest mode still works
    OAuth = None

PROVIDERS = {
    "google": {
        "label": "Google",
        "icon": "ph-google-logo",
        "env": "GOOGLE",
        "options": {
            "server_metadata_url": "https://accounts.google.com/.well-known/openid-configuration",
            "client_kwargs": {"scope": "openid email profile"},
        },
    },
    "github": {
        "label": "GitHub",
        "icon": "ph-github-logo",
        "env": "GITHUB",
        "options": {
            "access_token_url": "https://github.com/login/oauth/access_token",
            "authorize_url": "https://github.com/login/oauth/authorize",
            "api_base_url": "https://api.github.com/",
            "client_kwargs": {"scope": "read:user"},
        },
    },
}

oauth = OAuth(app) if OAuth else None
for name, provider in PROVIDERS.items():
    client_id = os.environ.get(f"{provider['env']}_CLIENT_ID")
    client_secret = os.environ.get(f"{provider['env']}_CLIENT_SECRET")
    provider["enabled"] = bool(oauth and client_id and client_secret)
    if provider["enabled"]:
        oauth.register(name, client_id=client_id, client_secret=client_secret, **provider["options"])


@app.context_processor
def inject_user():
    return {"current_user": session.get("user"), "providers": PROVIDERS}


# ---------- per-user storage ----------

def connect():
    return sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)


def init_db():
    conn = connect()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS repos (
                user_key   TEXT PRIMARY KEY,
                state      TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)
        # Drop guest sandboxes nobody has touched in a while
        cutoff = int(time.time()) - GUEST_RETENTION_DAYS * 86400
        conn.execute("DELETE FROM repos WHERE user_key LIKE 'guest:%' AND updated_at < ?", (cutoff,))
    finally:
        conn.close()


init_db()


def user_key():
    """ Identifies whose repository this request works on. Guests get a random id in their session cookie. """
    session.permanent = True
    if "uid" not in session:
        session["uid"] = f"guest:{uuid.uuid4().hex}"
    return session["uid"]


def new_repo():
    return {
        "commits": [],               # every commit ever made, in chronological order
        "branches": {"main": []},    # branch name -> ordered list of commit ids (its history)
        "staging_area": {},          # filename -> content
        "current_branch": "main",
        "previous_branch": None,
    }


def with_repo(view):
    """ Loads the caller's repository into g.repo and saves it afterwards, all in one locked transaction """
    @wraps(view)
    def wrapper(*args, **kwargs):
        key = user_key()
        conn = connect()
        try:
            conn.execute("BEGIN IMMEDIATE")  # serialises concurrent requests (e.g. two tabs) for safety
            row = conn.execute("SELECT state FROM repos WHERE user_key = ?", (key,)).fetchone()
            g.repo = json.loads(row[0]) if row else new_repo()
            result = view(*args, **kwargs)
            conn.execute(
                "INSERT INTO repos (user_key, state, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(user_key) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
                (key, json.dumps(g.repo), int(time.time())),
            )
            conn.execute("COMMIT")
            return result
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()
    return wrapper


# ---------- repository helpers ----------

def get_commit(commit_id):
    return next((c for c in g.repo["commits"] if c["id"] == commit_id), None)


def head(branch):
    history = g.repo["branches"].get(branch) or []
    return history[-1] if history else None


def snapshot(branch):
    """ Files as they exist at the tip of a branch """
    files = {}
    for commit_id in g.repo["branches"].get(branch, []):
        commit = get_commit(commit_id)
        if commit:
            files.update(commit["files"])
    return files


def make_commit_id(*parts):
    seed = "|".join(str(p) for p in parts) + f"|{time.time_ns()}|{len(g.repo['commits'])}"
    commit_id = hashlib.sha1(seed.encode()).hexdigest()[:7]
    while get_commit(commit_id):
        commit_id = hashlib.sha1(f"{commit_id}{seed}".encode()).hexdigest()[:7]
    return commit_id


def serialize():
    return {**g.repo, "working_tree": snapshot(g.repo["current_branch"])}


def respond(message, ok=True, **extra):
    return jsonify({"ok": ok, "message": message, "state": serialize(), **extra}), (200 if ok else 400)


def plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def payload():
    return request.get_json(silent=True) or {}


# ---------- routes ----------

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/simulation')
def simulation():
    user_key()  # make sure this browser has its own sandbox
    return render_template('simulation.html')


@app.route('/login')
def login_page():
    if session.get("user"):
        return redirect(url_for("simulation"))
    return render_template('login.html', error=request.args.get("error"))


@app.route('/login/<provider>')
def login(provider):
    if not PROVIDERS.get(provider, {}).get("enabled"):
        abort(404)
    redirect_uri = url_for("auth_callback", provider=provider, _external=True)
    return oauth.create_client(provider).authorize_redirect(redirect_uri)


@app.route('/auth/<provider>/callback')
def auth_callback(provider):
    if not PROVIDERS.get(provider, {}).get("enabled"):
        abort(404)
    client = oauth.create_client(provider)
    try:
        token = client.authorize_access_token()
        if provider == "google":
            info = token.get("userinfo") or client.userinfo()
            account = f"google:{info['sub']}"
            user = {"name": info.get("name") or info.get("email"), "avatar": info.get("picture")}
        else:
            info = client.get("user", token=token).json()
            account = f"github:{info['id']}"
            user = {"name": info.get("name") or info["login"], "avatar": info.get("avatar_url")}
    except Exception as err:
        app.logger.warning("%s sign-in failed: %s", provider, err)
        return redirect(url_for("login_page", error=f"{PROVIDERS[provider]['label']} sign-in was cancelled or failed. Please try again."))

    user["provider"] = PROVIDERS[provider]["label"]

    # Keep the guest's work: move it to the account if the account has no repository yet
    guest = session.get("uid", "")
    if guest.startswith("guest:"):
        conn = connect()
        try:
            if not conn.execute("SELECT 1 FROM repos WHERE user_key = ?", (account,)).fetchone():
                conn.execute("UPDATE repos SET user_key = ? WHERE user_key = ?", (account, guest))
        finally:
            conn.close()

    session.clear()  # fresh session after login
    session["uid"] = account
    session["user"] = user
    return redirect(url_for("simulation"))


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.route('/state')
@with_repo
def get_state():
    return jsonify(serialize())


@app.route('/reset', methods=['POST'])
@with_repo
def reset():
    g.repo = new_repo()
    return respond("Repository reset. Fresh start on 'main'.")


@app.route('/add', methods=['POST'])
@with_repo
def add():
    repo = g.repo
    data = payload()
    filename = (data.get('filename') or "").strip()
    content = data.get('content') or ""

    if not filename or not content.strip():
        return respond("Filename and content are required.", ok=False)

    if snapshot(repo["current_branch"]).get(filename) == content and filename not in repo["staging_area"]:
        return respond(f"No changes in '{filename}' compared to the last commit.", ok=False)

    repo["staging_area"][filename] = content
    return respond(f"Staged '{filename}'.")


@app.route('/unstage', methods=['POST'])
@with_repo
def unstage():
    repo = g.repo
    filename = payload().get('filename')
    if filename not in repo["staging_area"]:
        return respond(f"'{filename}' is not staged.", ok=False)
    repo["staging_area"].pop(filename)
    return respond(f"Unstaged '{filename}'.")


@app.route('/switch_branch', methods=['POST'])
@with_repo
def switch_branch():
    repo = g.repo
    target_branch = (payload().get('target_branch') or "").strip()

    if not target_branch:
        return respond("Target branch is required.", ok=False)

    if target_branch not in repo["branches"]:
        return respond(f"Branch '{target_branch}' does not exist.", ok=False)

    if target_branch == repo["current_branch"]:
        return respond(f"Already on '{target_branch}'.", ok=False)

    repo["previous_branch"] = repo["current_branch"]
    repo["current_branch"] = target_branch

    return respond(f"Switched to branch '{target_branch}'.")


@app.route('/commit', methods=['POST'])
@with_repo
def commit():
    repo = g.repo
    data = payload()
    message = (data.get('message') or "").strip()

    if not message:
        return respond("A commit message is required.", ok=False)

    if not repo["staging_area"]:
        return respond("Nothing to commit: the staging area is empty.", ok=False)

    # Commit the selected files, or everything staged if no selection was sent
    committed_files = data.get("committed_files")
    if committed_files is None:
        committed_files = list(repo["staging_area"])
    committed_files = [f for f in committed_files if f in repo["staging_area"]]
    if not committed_files:
        return respond("Select at least one staged file to commit.", ok=False)

    branch = repo["current_branch"]
    parent = head(branch)
    files = {f: repo["staging_area"][f] for f in committed_files}

    commit_data = {
        'id': make_commit_id(parent, message, sorted(files.items())),
        'message': message,
        'files': files,
        'branch': branch,                     # branch this commit was created on
        'parents': [parent] if parent else [],
        'type': 'commit',
        'timestamp': int(time.time()),
    }

    repo["commits"].append(commit_data)
    repo["branches"][branch].append(commit_data["id"])

    for filename in committed_files:
        repo["staging_area"].pop(filename, None)

    count = len(files)
    return respond(f"[{branch} {commit_data['id']}] {message} ({count} file{'s' if count != 1 else ''})")


@app.route('/branch', methods=['POST'])
@with_repo
def create_branch():
    repo = g.repo
    data = payload()
    branch_name = (data.get('branch_name') or "").strip()
    checkout = data.get('checkout', True)

    if not branch_name:
        return respond("Branch name is required.", ok=False)

    if not BRANCH_NAME_RE.match(branch_name) or ".." in branch_name or branch_name.endswith(("/", ".")):
        return respond("Invalid branch name. Use letters, numbers, '-', '_', '.' or '/' (no spaces).", ok=False)

    if branch_name in repo["branches"]:
        return respond(f"Branch '{branch_name}' already exists.", ok=False)

    # New branch starts with the same history as the current branch
    repo["branches"][branch_name] = repo["branches"][repo["current_branch"]][:]

    if not checkout:
        return respond(f"Created branch '{branch_name}'.")

    repo["previous_branch"] = repo["current_branch"]
    repo["current_branch"] = branch_name
    return respond(f"Created and switched to branch '{branch_name}'.")


@app.route('/merge', methods=['POST'])
@with_repo
def merge():
    repo = g.repo
    data = payload()
    source_branch = (data.get('source_branch') or "").strip()
    target_branch = repo["current_branch"]

    # Content chosen by the user for conflicting files: {filename: content}
    resolutions = data.get('resolutions') or {}
    if not isinstance(resolutions, dict) or not all(isinstance(v, str) for v in resolutions.values()):
        return respond("Invalid conflict resolutions.", ok=False)

    if source_branch not in repo["branches"]:
        return respond(f"Branch '{source_branch}' does not exist.", ok=False)

    if source_branch == target_branch:
        return respond("Cannot merge a branch into itself.", ok=False)

    target_history = repo["branches"][target_branch]
    source_history = repo["branches"][source_branch]
    target_set, source_set = set(target_history), set(source_history)

    theirs = [c for c in source_history if c not in target_set]
    if not theirs:
        return respond(f"Already up to date: '{target_branch}' has everything from '{source_branch}'.", ok=False)

    # Fast-forward when the target has no commits of its own
    if target_set <= source_set:
        repo["branches"][target_branch] = source_history[:]
        return respond(f"Fast-forwarded '{target_branch}' to '{source_branch}' ({len(theirs)} commit{'s' if len(theirs) != 1 else ''}).")

    # Three-way comparison against the shared history (merge base)
    base_files = {}
    for commit_id in target_history:
        if commit_id in source_set:
            base_files.update(get_commit(commit_id)["files"])

    target_files, source_files = snapshot(target_branch), snapshot(source_branch)
    our_changes = {f for f in target_files if target_files[f] != base_files.get(f)}
    their_changes = {f for f in source_files if source_files[f] != base_files.get(f)}
    conflicts = sorted(
        f for f in our_changes & their_changes
        if target_files.get(f) != source_files.get(f)
    )
    unresolved = [f for f in conflicts if f not in resolutions]
    if unresolved:
        return respond(
            f"CONFLICT: both '{target_branch}' and '{source_branch}' changed {', '.join(unresolved)}. "
            f"Choose which version to keep to finish the merge.",
            ok=False,
            conflict={
                "source": source_branch,
                "target": target_branch,
                "ours_head": head(target_branch),
                "theirs_head": head(source_branch),
                "files": [
                    {"name": f, "base": base_files.get(f), "ours": target_files[f], "theirs": source_files[f]}
                    for f in conflicts
                ],
            },
        )

    still_marked = [f for f in conflicts if CONFLICT_MARKER_RE.search(resolutions[f])]
    if still_marked:
        return respond(f"{', '.join(still_marked)} still contains conflict markers (<<<<<<<, =======, >>>>>>>).", ok=False)

    merged_files = {f: source_files[f] for f in their_changes if f not in conflicts}
    merged_files.update({f: resolutions[f] for f in conflicts})

    merge_message = f"Merge branch '{source_branch}' into {target_branch}"
    merge_commit = {
        "id": make_commit_id(head(target_branch), head(source_branch), merge_message),
        "message": merge_message,
        "files": merged_files,
        "resolved_conflicts": conflicts,
        "branch": target_branch,
        "parents": [head(target_branch), head(source_branch)],
        "type": "merge",
        "timestamp": int(time.time()),
    }

    repo["commits"].append(merge_commit)
    repo["branches"][target_branch].extend(theirs + [merge_commit["id"]])

    resolved_note = f", resolved {plural(len(conflicts), 'conflict')}" if conflicts else ""
    return respond(f"Merged '{source_branch}' into '{target_branch}' ({merge_commit['id']}{resolved_note}).")


if __name__ == '__main__':
    app.run(debug=True)
