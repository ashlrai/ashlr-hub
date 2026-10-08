//! Native updater HTTP construction shared by runtime and required library tests.

use std::time::Duration;

pub fn allowed_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}

pub fn client() -> Result<reqwest::Client, &'static str> {
    // rustls-no-provider requires a process default before reqwest construction.
    // Installation is once-only; concurrent clients retain the installed provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() < 5 && allowed_url(a.url()) {
                a.follow()
            } else {
                a.stop()
            }
        }))
        .build()
        .map_err(|_| "download-unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn updater_client_constructs_in_a_fresh_process_without_network() {
        const CHILD: &str = "PHANTOM_TLS_CLIENT_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            assert!(rustls::crypto::CryptoProvider::get_default().is_none());
            client().expect("updater client must configure its TLS provider");
            client().expect("repeated construction must remain safe");
            assert!(rustls::crypto::CryptoProvider::get_default().is_some());
            return;
        }
        // A separate test process prevents another TLS test from masking startup.
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_update_client::tests::updater_client_constructs_in_a_fresh_process_without_network",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fresh updater client failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed;"),
            "fresh-process filter must execute the actual constructor case"
        );
    }

    #[test]
    fn https_redirects_have_a_closed_origin_set() {
        for good in [
            "https://github.com/a",
            "https://release-assets.githubusercontent.com/a",
        ] {
            assert!(allowed_url(&reqwest::Url::parse(good).unwrap()));
        }
        for bad in [
            "http://github.com/a",
            "https://github.com.evil.test/a",
            "https://user@github.com/a",
            "https://github.com:444/a",
        ] {
            assert!(!allowed_url(&reqwest::Url::parse(bad).unwrap()));
        }
    }
}
