//! Optional authenticated activity metadata. Unknown contracts never claim work.
use serde::{Deserialize, Deserializer};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct LocalWork {
    #[serde(rename = "sourceVersion", default)]
    pub source_version: Option<u8>,
    #[serde(rename = "localRuns")]
    pub local_runs: Option<usize>,
    #[serde(rename = "chatRuns", default)]
    pub chat_runs: Option<usize>,
    #[serde(rename = "fleetRuns", default)]
    pub fleet_runs: Option<usize>,
}
impl LocalWork {
    pub fn counts(&self) -> (Option<usize>, Option<usize>) {
        match self.source_version {
            Some(1) => (self.chat_runs, self.fleet_runs),
            None => (self.local_runs, self.local_runs.map(|_| 0)),
            Some(_) => (None, None),
        }
    }
}

/// Bad optional metadata must not discard valid completions, tray or notifications.
pub fn decode<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<LocalWork>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Deserialize)]
    struct Envelope {
        cursor: String,
        #[serde(rename = "localWork", default, deserialize_with = "decode")]
        local_work: Option<LocalWork>,
    }
    #[test]
    fn malformed_optional_metadata_preserves_the_base_envelope() {
        for value in [
            "null",
            "[]",
            "true",
            r#"{"localRuns":-1}"#,
            r#"{"localRuns":"busy"}"#,
        ] {
            let parsed: Envelope =
                serde_json::from_str(&format!(r#"{{"cursor":"valid","localWork":{value}}}"#))
                    .unwrap();
            assert_eq!(parsed.cursor, "valid");
            assert_eq!(parsed.local_work, None);
        }
    }
    #[test]
    fn future_source_version_cannot_claim_work() {
        let work: LocalWork = serde_json::from_str(
            r#"{"sourceVersion":2,"localRuns":10,"chatRuns":5,"fleetRuns":5}"#,
        )
        .unwrap();
        assert_eq!(work.counts(), (None, None));
    }
    #[test]
    fn supported_sources_and_legacy_counts_remain_independent() {
        let work: LocalWork = serde_json::from_str(
            r#"{"sourceVersion":1,"localRuns":1,"chatRuns":1,"fleetRuns":null}"#,
        )
        .unwrap();
        assert_eq!(work.counts(), (Some(1), None));
        let unknown: LocalWork = serde_json::from_str(
            r#"{"sourceVersion":1,"localRuns":null,"chatRuns":null,"fleetRuns":null}"#,
        )
        .unwrap();
        assert_eq!(unknown.counts(), (None, None));
        let legacy: LocalWork = serde_json::from_str(r#"{"localRuns":3}"#).unwrap();
        assert_eq!(legacy.counts(), (Some(3), Some(0)));
    }
}
