-- self-hosted GitLab: SSH host key trusted on first use (docs/API.md → create_remote)
ALTER TABLE user_accounts ADD COLUMN ssh_known_hosts TEXT;          -- one known_hosts line
ALTER TABLE user_accounts ADD COLUMN ssh_host_key_fingerprint TEXT; -- SHA256:… of that key
