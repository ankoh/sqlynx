use semver::Version;
use serde::{self, Deserialize, Deserializer, Serializer};

pub fn serialize<S>(version: &Version, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let s = version.to_string();
    serializer.serialize_str(&s)
}
pub fn deserialize<'de, D>(deserializer: D) -> Result<Version, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    let v = Version::parse(&s).unwrap_or(Version::new(0, 0, 0));
    Ok(v)
}
