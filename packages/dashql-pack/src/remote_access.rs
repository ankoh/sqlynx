use anyhow::Result;
use std::env;

pub struct RemoteAccess {
    pub r2_endpoint: String,
    pub r2_access_key_id: String,
    pub r2_secret_access_key: String,
}

impl RemoteAccess {
    pub fn from_env() -> Result<RemoteAccess> {
        let r2_endpoint = env::var("DASHQL_GET_R2_ENDPOINT").map_err(|e| {
            anyhow::anyhow!(
                "failed to access environment variable DASHQL_GET_R2_ENDPOINT: {}",
                e
            )
        })?;
        let r2_access_key_id = env::var("DASHQL_GET_R2_ACCESS_KEY_ID").map_err(|e| {
            anyhow::anyhow!(
                "failed to access environment variable DASHQL_GET_R2_ACCESS_KEY_ID: {}",
                e
            )
        })?;
        let r2_secret_access_key = env::var("DASHQL_GET_R2_SECRET_ACCESS_KEY").map_err(|e| {
            anyhow::anyhow!(
                "failed to access environment variable DASHQL_GET_R2_SECRET_ACCESS_KEY: {}",
                e
            )
        })?;
        // Interestingly, doing the is_empty check results in unreachable warnings
        assert!(!r2_endpoint.is_empty());
        assert!(!r2_access_key_id.is_empty());
        assert!(!r2_secret_access_key.is_empty());
        Ok(RemoteAccess {
            r2_endpoint,
            r2_access_key_id,
            r2_secret_access_key,
        })
    }

    pub fn get_credentials(&self) -> aws_credential_types::Credentials {
        aws_credential_types::Credentials::new(
            self.r2_access_key_id.clone(),
            self.r2_secret_access_key.clone(),
            None,
            None,
            "r2",
        )
    }
}
