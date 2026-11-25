# Login setup (GitHub / Google OAuth)

undertree has **no passwords**. Users log in with GitHub or Google, and only accounts registered
by an admin can get in.

## 1. Register users

```sh
undertree user add alice --display-name "Alice A." --github alice-gh --admin
undertree user add bob --email bob@uni.example        # must be bob's verified Google address
undertree user list
undertree user remove bob                             # bob's sessions end immediately
```
In Docker: `docker compose exec undertree undertree user add …`.

- **GitHub**: on the first login the GitHub account whose login equals `--github` is linked by its
  numeric id. After that the id counts, so renaming the GitHub account changes nothing, and
  someone who later takes over the old login name cannot get in.
- **Google**: matched by e-mail (case-insensitive), only if Google reports it as verified.

## 2. Create the OAuth apps

Callback URLs use `UNDERTREE_PUBLIC_URL` (e.g. `https://<DEINE-DOMAIN.TLD>`).

**GitHub** — Settings → Developer settings → OAuth Apps → New OAuth App
- Homepage URL: `https://<DEINE-DOMAIN.TLD>`
- Authorization callback URL: `https://<DEINE-DOMAIN.TLD>/api/auth/oauth/github/callback`
- Set `UNDERTREE_GITHUB_CLIENT_ID` / `UNDERTREE_GITHUB_CLIENT_SECRET`. No scopes are requested.

**Google** — Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID
→ *Web application* (consent screen: scopes `openid`, `email`)
- Authorized redirect URI: `https://<DEINE-DOMAIN.TLD>/api/auth/oauth/google/callback`
- Set `UNDERTREE_GOOGLE_CLIENT_ID` / `UNDERTREE_GOOGLE_CLIENT_SECRET`.

A provider shows up on the login page (`GET /api/auth/providers`) only when both of its variables are set.

## Local development without OAuth apps

```sh
undertree user add alice --github alice
UNDERTREE_DEV_LOGIN=true undertree serve
curl -c jar -H 'content-type: application/json' -d '{"username":"alice"}' localhost:3000/api/auth/dev-login
```
The server refuses to start with `UNDERTREE_DEV_LOGIN=true` and an `https://` public URL.

## Login errors

The callback redirects to `/login?error=<code>`:
`oauth_denied` (user cancelled at the provider), `not_registered` (no matching user),
`oauth_failed` (state mismatch, expired attempt, provider error — details in the server log).
