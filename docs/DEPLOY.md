# Deployment (Docker Compose + Caddy)

One container (`undertree serve` + `git` + `latexmk`/TeX Live) behind a reverse proxy that
terminates HTTPS for `<DEINE-DOMAIN.TLD>`. The container listens on `127.0.0.1:3000` of the host
only; the proxy is the sole way in.

```
browser ──https──> Caddy (host) ──http──> 127.0.0.1:3000 ──> container :3000
                                                          ├─ /data       (./data)
                                                          └─ ~/.ssh      (./ssh, read-only)
```

## 1. Prepare the host directories

The container runs as **uid 1000** (user `undertree`). Everything it mounts must belong to that uid.

```sh
git clone <this repo> undertree && cd undertree
cp .env.example .env                      # fill in, see step 2

# optional: server SSH key, only for projects with an ssh:// or git@host:path remote
# (add id_ed25519.pub as a deploy key with write access on those remotes and their submodules)
mkdir ssh
ssh-keygen -t ed25519 -N '' -C undertree -f ssh/id_ed25519
ssh-keyscan github.com gitlab.com > ssh/known_hosts   # add your own Git hosts
chmod 700 ssh && chmod 600 ssh/id_ed25519

mkdir -p data
sudo chown -R 1000:1000 data ssh
```

`ssh` refuses keys that are readable by others, and `git` refuses repos owned by another uid
("dubious ownership"), so the `chown` is not optional. Missing host keys make `git push` fail
instead of prompting (`StrictHostKeyChecking=yes` in `docker-compose.yml`): extend
`ssh/known_hosts`, not the SSH options.

Repositories are not prepared on the host: users create **projects** in the UI from a git URL.
For `https://` remotes they enter an access token (GitLab/GitHub PAT, username defaults to
`oauth2`), which is stored encrypted and only handed to the `git` process. Clones live in
`./data/projects/{id}/repo`. Submodules must use `https://` or SSH URLs (local and `file://`
submodules are refused, so a repo cannot read other projects' clones).

## 2. Configure `.env`

See `.env.example` and docs/API.md → *Configuration (env)*. The essentials:

```sh
UNDERTREE_PUBLIC_URL=https://<DEINE-DOMAIN.TLD>
UNDERTREE_GITHUB_CLIENT_ID=… / UNDERTREE_GITHUB_CLIENT_SECRET=…
UNDERTREE_GOOGLE_CLIENT_ID=… / UNDERTREE_GOOGLE_CLIENT_SECRET=…
# optional: key for stored git tokens; otherwise ./data/secret.key is generated (mode 0600)
# UNDERTREE_SECRET_KEY=$(openssl rand -base64 32)
```

OAuth callback URLs to register with the providers (details in [AUTH.md](AUTH.md)):

- GitHub: `https://<DEINE-DOMAIN.TLD>/api/auth/oauth/github/callback`
- Google: `https://<DEINE-DOMAIN.TLD>/api/auth/oauth/google/callback`

`UNDERTREE_BIND`, `UNDERTREE_DATA` and `UNDERTREE_STATIC_DIR` are set by
the image. **Never set `UNDERTREE_DEV_LOGIN`** in production (the server refuses to start with it
and an https URL anyway).

## 3. Start and create the first admin

```sh
docker compose up -d --build      # first build downloads TeX Live, takes a few minutes
docker compose ps                 # STATUS should become "healthy" (GET /api/health)
docker compose exec undertree undertree user add alice --github alice-gh --admin
docker compose exec undertree undertree user add bob --email bob@uni.example
docker compose exec undertree undertree user list
```

There is no self-registration: only users added this way (or by an admin in the UI) can log in.
Then log in and create the first project from its git URL.

### Creating repos from undertree (GitHub / GitLab)

Users can connect accounts in their profile and then create a new repo with CI under
"Neues Projekt → Neues Repo anlegen":

- **GitHub:** "GitHub verbinden" reuses the login OAuth App and its callback URL, so **nothing
  changes in the OAuth App**. GitHub asks the user once more to authorize, now with the scopes
  `repo` and `workflow`; the login itself stays scope-less.
- **GitLab (gitlab.com or self-hosted):** server URL + personal access token with scope `api`.
  Any GitLab reachable from the internet via https works (not behind a VPN): undertree refuses
  servers that resolve to private/internal addresses, so a user can't make it probe internal
  hosts. To allow only certain servers, list them:
  ```sh
  UNDERTREE_GITLAB_HOSTS=gitlab.com,git.uni.example,git.lab.example:8443   # default: empty = any
  ```
  Entries are `host` or `host:port` exactly as in the server URL. Removing a host disables
  accounts already connected to it.

Every created repo gets its own SSH deploy key with write access (`./data/projects/{id}/ssh/`),
so these projects don't use the `./ssh` key above. Host keys are checked strictly: github.com
and gitlab.com keys are pinned in undertree (from the providers' official pages). A
**self-hosted GitLab**'s ed25519 key is trusted on first use: scanned when the account creates
its first repo and stored on the account (fingerprint in `GET /api/accounts`); a later change
fails closed. To pin a key yourself instead, add it to `./ssh/known_hosts` after comparing the
fingerprint with one your GitLab admin publishes:

```sh
ssh-keyscan -t ed25519 git.uni.example > /tmp/key && ssh-keygen -lf /tmp/key   # compare!
cat /tmp/key >> ssh/known_hosts
```

The account token is
only needed to create the repo and to invite members
("Ins Remote einladen" in the project settings; GitHub needs the member's GitHub login in the
user list). Deleting a project in undertree never deletes the remote repo.

## 4. Reverse proxy

**Caddy** (recommended): [`deploy/Caddyfile`](../deploy/Caddyfile). Copy it to
`/etc/caddy/Caddyfile` (or merge it into yours) and `systemctl reload caddy`. Caddy obtains the
certificate itself and proxies WebSockets (`/ws/projects/{pid}/doc/*`, `/ws/projects/{pid}/events`) without extra config.

**nginx** alternative: WebSockets need the Upgrade headers, and long-lived sockets a long timeout.

```nginx
server {
    listen 443 ssl http2;
    server_name <DEINE-DOMAIN.TLD>;
    # ssl_certificate … / ssl_certificate_key …
    client_max_body_size 64m;                 # file upload limit of the API

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 1h;
    }
}
# in the http {} block:
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

The `Host` must stay `<DEINE-DOMAIN.TLD>`: WebSocket connections are only accepted when the
browser's `Origin` equals `UNDERTREE_PUBLIC_URL`.

## TeX Live

The runtime image is the official full TeX Live (`texlive/texlive:latest`, ~5 GB: every CTAN
package, pdfLaTeX/XeLaTeX/LuaLaTeX, biber, latexmk), like Overleaf. The engine is chosen per project
(project settings → Compiler). To pin a TeX Live year instead of `latest`:

```sh
docker build --build-arg TEXLIVE_IMAGE=texlive/texlive:TL2025-historic -t undertree .
```

Compiles run in a Landlock sandbox (read-only system, write only the build dir, no `/data`, no
`/proc`, empty environment). This needs a Linux kernel with Landlock (5.13+, enabled in the `lsm=`
list; check `cat /sys/kernel/security/lsm`); without it every compile fails with
"sandbox unavailable" instead of running unconfined.

## Spell check (LanguageTool)

Optional. `docker-compose.yml` has a `languagetool` service (`erikvl87/languagetool`, pinned
version) behind the compose profile `spellcheck`: without the profile it is not started, and
without `UNDERTREE_LANGUAGETOOL_URL` undertree shows no spell check. To enable both, add to `.env`:

```sh
COMPOSE_PROFILES=spellcheck
UNDERTREE_LANGUAGETOOL_URL=http://languagetool:8010
```

then `docker compose up -d`. The container needs about **1–1.5 GB RAM** (`Java_Xmx=1g`,
`mem_limit: 1536m`) and is only reachable on the internal compose network (no published port).
The first check after a start takes a few seconds while LanguageTool loads. Users pick
"Rechtschreibprüfung" in the project settings (per browser); the project dictionary and ignored
rules are shared by all members. To update LanguageTool, change the image tag and run
`docker compose up -d` again.

## Backups

- `./data`: SQLite DB (users, sessions, projects, encrypted tokens), `secret.key`, and per
  project the clone, CRDT state and build output (`projects/{id}/{repo,ydocs,build}`). Back it
  up consistently with the container stopped (`docker compose stop`, copy, `docker compose start`),
  or copy `undertree.db` with `sqlite3 data/undertree.db ".backup backup.db"` while running.
  Everything committed is also on the Git remotes; uncommitted edits exist only here.
- `.env`, `data/secret.key` and `ssh/`: secrets, keep a copy somewhere safe. Without the key,
  stored tokens cannot be decrypted (re-enter them in the project settings).

## Updating

```sh
git pull
docker compose up -d --build      # rebuilds the image, restarts the container; DB migrates itself
docker image prune -f             # optional: drop old images
```

Users, sessions, projects and document state survive: they live in `./data`.
Upgrading from a single-workspace version: the old `./workspace` mount is gone; create it as a
project from its remote URL in the UI.
