//! SSRF guard for servers users name themselves (their GitLab's API and SSH host): `https` only,
//! every address the host resolves to must be public, and the connection is pinned to the vetted
//! address (no DNS rebinding), without redirects or proxies.
//!
//! `allow_private` (= `AppState::allow_file`) is a test-only escape hatch for local mock servers:
//! it also allows `http://`. Production always runs with `false`.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::Path,
    time::Duration,
};

use axum::http::StatusCode;
use oauth2::{reqwest, url::Url};

use crate::{accounts::remote_failed, error::ApiError};

pub fn not_allowed(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "host_not_allowed", msg)
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0 // "this network" 0/8
        || a >= 240 // reserved 240/4, broadcast
        || (a == 100 && b & 0xc0 == 64) // CGNAT 100.64/10
        || (a == 198 && b & 0xfe == 18) // benchmarking 198.18/15
        || (a == 192 && b == 0 && c == 0)) // IETF protocol assignments 192.0.0/24
}

/// Globally reachable unicast address.
pub fn is_public(ip: IpAddr) -> bool {
    let v6 = match ip {
        IpAddr::V4(v4) => return public_v4(v4),
        IpAddr::V6(v6) => v6,
    };
    if let Some(v4) = v6.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s = v6.segments();
    // only global unicast 2000::/3: excludes ::, ::1, ULA fc00::/7, link-local fe80::/10,
    // multicast ff00::/8, NAT64 64:ff9b::/96, IPv4-compatible ::a.b.c.d
    s[0] & 0xe000 == 0x2000
        && !(s[0] == 0x2001 && s[1] < 0x200) // 2001::/23: Teredo, benchmarking, ORCHID
        && !(s[0] == 0x2001 && s[1] == 0xdb8) // documentation 2001:db8::/32
        && !(s[0] == 0x3fff && s[1] < 0x1000) // documentation 3fff::/20
        // 6to4 2002::/16 embeds an IPv4 address
        && !(s[0] == 0x2002 && !public_v4(Ipv4Addr::from(((s[1] as u32) << 16) | s[2] as u32)))
}

/// The address to connect to for `host:port`: every address `host` resolves to must be public.
pub async fn vet(host: &str, port: u16, allow_private: bool) -> Result<SocketAddr, ApiError> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let lookup = tokio::net::lookup_host((bare, port));
    let addrs: Vec<SocketAddr> = tokio::time::timeout(Duration::from_secs(10), lookup)
        .await
        .map_err(|_| remote_failed(format!("{host}: DNS lookup timed out")))?
        .map_err(|e| remote_failed(format!("{host} cannot be resolved: {e}")))?
        .collect();
    let first = *addrs
        .first()
        .ok_or_else(|| remote_failed(format!("{host} cannot be resolved")))?;
    if !allow_private && addrs.iter().any(|a| !is_public(a.ip())) {
        return Err(not_allowed(format!(
            "{host} is not publicly reachable (it resolves to a private or reserved address); \
             only servers reachable from the internet without VPN can be used"
        )));
    }
    Ok(first)
}

/// An HTTP client for `url` only: `https`, connecting to the vetted address, no redirects.
pub async fn client(url: &str, allow_private: bool) -> Result<reqwest::Client, ApiError> {
    let u = Url::parse(url).map_err(|_| not_allowed(format!("invalid server URL {url}")))?;
    match u.scheme() {
        "https" => {}
        "http" if allow_private => {}
        _ => return Err(not_allowed("only https:// servers are supported")),
    }
    let host = (u.host_str()).ok_or_else(|| not_allowed(format!("{url} has no host")))?;
    let port = u.port_or_known_default().unwrap_or(443);
    let addr = vet(host, port, allow_private).await?;
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // a proxy would resolve the name itself, past the pinned address
        .no_proxy()
        .resolve(host, addr)
        .user_agent("undertree")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(ApiError::internal)
}

/// `(host, port)` of an SSH remote `ssh://[user@]host[:port]/path` or `user@host:path`
/// (brackets of IPv6 literals removed); `None` for other URLs.
pub fn ssh_host(url: &str) -> Option<(String, u16)> {
    let (authority, scp) = match url.strip_prefix("ssh://") {
        Some(rest) => (rest.split('/').next()?, false),
        None if !url.contains("://") => (url, true),
        None => return None,
    };
    // scp form: the path may contain `@`, the user can't (`projects::validate_remote_url`)
    let user = if scp {
        authority.split_once('@')
    } else {
        authority.rsplit_once('@')
    };
    let hostport = user.map_or(authority, |(_, h)| h);
    let (host, port) = if let Some(rest) = hostport.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        (
            host,
            after.strip_prefix(':').filter(|p| !scp && !p.is_empty()),
        )
    } else {
        match hostport.split_once(':') {
            // scp form: everything after the `:` is the path
            Some((host, _)) if scp => (host, None),
            Some((host, port)) => (host, Some(port)),
            None if scp => return None,
            None => (hostport, None),
        }
    };
    let port = port.map_or(Some(22), |p| p.parse().ok())?;
    // a name (`[A-Za-z0-9.-]`, no leading `-`: ssh would read it as an option) or an IPv6 literal
    let name = !hostport.starts_with('[')
        && !host.is_empty()
        && !host.starts_with('-')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    let ipv6 = hostport.starts_with('[') && host.parse::<std::net::Ipv6Addr>().is_ok();
    (name || ipv6).then(|| (host.to_ascii_lowercase(), port))
}

/// Home directory of the current user from `/etc/passwd`, which is where ssh expands `~`.
pub fn passwd_home() -> Option<std::path::PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let uid = std::fs::metadata("/proc/self").ok()?.uid();
    home_in_passwd(&std::fs::read_to_string("/etc/passwd").ok()?, uid)
}

fn home_in_passwd(passwd: &str, uid: u32) -> Option<std::path::PathBuf> {
    passwd.lines().find_map(|l| {
        let f: Vec<&str> = l.split(':').collect();
        (f.get(2)?.parse() == Ok(uid)).then(|| f.get(5).map(std::path::PathBuf::from))?
    })
}

/// Host field of a `known_hosts` line, as ssh looks it up.
pub fn known_hosts_host(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Trust on first use: the ed25519 host key of `host:port`, scanned at its vetted address, as a
/// `known_hosts` line under the host's name.
pub async fn keyscan(host: &str, port: u16, allow_private: bool) -> Result<String, ApiError> {
    let addr = vet(host, port, allow_private).await?;
    let scan = tokio::process::Command::new("ssh-keyscan")
        .args(["-T", "5", "-t", "ed25519", "-p", &port.to_string()])
        .arg(addr.ip().to_string())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(15), scan)
        .await
        .map_err(|_| remote_failed(format!("ssh-keyscan {host}: timed out")))?
        .map_err(|e| ApiError::internal(format!("ssh-keyscan: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let key = stdout.lines().find_map(|l| {
        let mut f = l.split_whitespace().skip(1);
        let b64 = |k: &str| (k.bytes()).all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b));
        match (f.next(), f.next()) {
            (Some("ssh-ed25519"), Some(k)) if b64(k) => Some(k.to_owned()),
            _ => None,
        }
    });
    let key = key.ok_or_else(|| {
        remote_failed(format!(
            "{host}:{port} sent no ed25519 SSH host key (is SSH reachable from the internet?)"
        ))
    })?;
    Ok(format!(
        "{} ssh-ed25519 {key}",
        known_hosts_host(host, port)
    ))
}

/// `SHA256:…` fingerprint of the (single) key in `known_hosts`.
pub async fn fingerprint(known_hosts: &Path) -> Result<String, ApiError> {
    let out = tokio::process::Command::new("ssh-keygen")
        .arg("-lf")
        .arg(known_hosts)
        .output()
        .await
        .map_err(|e| ApiError::internal(format!("ssh-keygen: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let fp = stdout
        .split_whitespace()
        .nth(1)
        .filter(|_| out.status.success());
    fp.map(str::to_owned)
        .ok_or_else(|| ApiError::internal(format!("ssh-keygen -lf: {stdout}")))
}

/// `undertree ssh-proxy <host> <port>`, ssh's `ProxyCommand` for project remotes: connects to an
/// address `host` resolves to only if all of them are public (like `vet`), then relays
/// stdin/stdout. So a DNS change after the host key was trusted can't point git's SSH at an
/// internal host, not even for the TCP handshake.
pub async fn ssh_proxy(host: &str, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    use tokio::io::AsyncWriteExt;
    let addr = vet(host, port, false).await.map_err(|e| e.message)?;
    let mut stream = tokio::net::TcpStream::connect(addr).await?;
    let (mut from_server, mut to_server) = stream.split();
    let (mut stdin, mut stdout) = (tokio::io::stdin(), tokio::io::stdout());
    let down = async {
        tokio::io::copy(&mut from_server, &mut stdout).await?;
        stdout.flush().await
    };
    tokio::pin!(down);
    tokio::select! {
        r = &mut down => return Ok(r?),
        r = tokio::io::copy(&mut stdin, &mut to_server) => {
            r?;
            to_server.shutdown().await?;
        }
    }
    Ok(down.await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_addresses() {
        let public = |s: &str| is_public(s.parse().unwrap());
        for ok in [
            "1.1.1.1",
            "141.2.3.4",
            "100.128.0.1",
            "198.20.0.1",
            "2a00:1450:4001::1",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
            "2002:0808:0808::1",
        ] {
            assert!(public(ok), "{ok}");
        }
        for bad in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.8",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "2001:0:4136:e378::1",
            "3fff::1",
            "2002:0a00:0001::1",
        ] {
            assert!(!public(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn rejects_private_and_plain_http_servers() {
        for url in [
            "https://localhost",
            "https://localhost:8443/gitlab",
            "https://127.0.0.1",
            "https://10.0.0.1",
            "https://[::1]",
            "https://[::ffff:192.168.0.1]",
            "http://1.1.1.1",
            "ftp://1.1.1.1",
        ] {
            let err = client(url, false).await.unwrap_err();
            assert_eq!(
                (err.status.as_u16(), err.code),
                (400, "host_not_allowed"),
                "{url}"
            );
        }
        // an IP literal needs no DNS: public is fine, the escape hatch admits local mocks
        assert!(client("https://1.1.1.1/gitlab", false).await.is_ok());
        assert!(client("http://127.0.0.1:1234", true).await.is_ok());
        let err = keyscan("localhost", 22, false).await.unwrap_err();
        assert_eq!(err.code, "host_not_allowed");
    }

    #[test]
    fn parses_ssh_hosts() {
        let h = |u: &str| ssh_host(u);
        let ok = |host: &str, port| Some((host.to_owned(), port));
        assert_eq!(h("git@git.uni.de:chair/paper.git"), ok("git.uni.de", 22));
        assert_eq!(h("git@Git.Uni.de:22/x.git"), ok("git.uni.de", 22));
        assert_eq!(h("ssh://git@git.uni.de/x.git"), ok("git.uni.de", 22));
        assert_eq!(h("ssh://git@git.uni.de:2222/x.git"), ok("git.uni.de", 2222));
        assert_eq!(h("ssh://git.uni.de:2222/x.git"), ok("git.uni.de", 2222));
        assert_eq!(h("ssh://git@[2001:db8::1]:2222/x"), ok("2001:db8::1", 2222));
        assert_eq!(h("git@[2001:db8::1]:x.git"), ok("2001:db8::1", 22));
        assert_eq!(h("git@git.uni.de:a@b.git"), ok("git.uni.de", 22));
        for none in [
            "file:///tmp/x.git",
            "https://git.uni.de/x.git",
            "ssh://git@host:port/x",
            "ssh:///x",
            "relative/path",
        ] {
            assert_eq!(h(none), None, "{none}");
        }
    }

    #[tokio::test]
    async fn fingerprints_known_hosts() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("known_hosts");
        let line = "[git.uni.de]:2222 ssh-ed25519 \
                    AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf\n";
        std::fs::write(&file, line).unwrap();
        match fingerprint(&file).await {
            // gitlab.com's published ed25519 fingerprint (it is gitlab.com's key)
            Ok(fp) => assert_eq!(fp, "SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8"),
            Err(e) if e.message.contains("No such file") => eprintln!("skipping: no ssh-keygen"),
            Err(e) => panic!("{}", e.message),
        }
    }

    #[test]
    fn ssh_host_accepts_only_plain_hostnames_and_ipv6() {
        assert_eq!(
            ssh_host("git@Git.Uni.de:a/b"),
            Some(("git.uni.de".into(), 22))
        );
        assert_eq!(
            ssh_host("ssh://git@[::1]:2222/a"),
            Some(("::1".into(), 2222))
        );
        for bad in [
            "ssh://git@-oProxyCommand=x/a",
            "ssh://git@a$(b)/a",
            "ssh://git@a b/a",
            "ssh://git@[not-ip]/a",
            "ssh://git@ex%41mple/a",
            "ssh://git@exämple.de/a",
        ] {
            assert_eq!(ssh_host(bad), None, "{bad}");
        }
    }

    #[test]
    fn passwd_home_by_uid() {
        let p = "root:x:0:0:root:/root:/bin/sh\nbob:x:1000:1000:Bob:/home/bob:/bin/fish\nbad\n";
        assert_eq!(home_in_passwd(p, 1000), Some("/home/bob".into()));
        assert_eq!(home_in_passwd(p, 7), None);
    }

    #[test]
    fn known_hosts_lines() {
        assert_eq!(known_hosts_host("git.uni.de", 22), "git.uni.de");
        assert_eq!(known_hosts_host("git.uni.de", 2222), "[git.uni.de]:2222");
    }
}
