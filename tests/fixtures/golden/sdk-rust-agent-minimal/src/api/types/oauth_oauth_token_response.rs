pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct OauthTokenResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<i64>,
}

impl OauthTokenResponse {
    pub fn builder() -> OauthTokenResponseBuilder {
        <OauthTokenResponseBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct OauthTokenResponseBuilder {
    access_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<i64>,
}

impl OauthTokenResponseBuilder {
    pub fn access_token(mut self, value: impl Into<String>) -> Self {
        self.access_token = Some(value.into());
        self
    }

    pub fn token_type(mut self, value: impl Into<String>) -> Self {
        self.token_type = Some(value.into());
        self
    }

    pub fn expires_in(mut self, value: i64) -> Self {
        self.expires_in = Some(value);
        self
    }

    /// Consumes the builder and constructs a [`OauthTokenResponse`].
    pub fn build(self) -> Result<OauthTokenResponse, BuildError> {
        Ok(OauthTokenResponse {
            access_token: self.access_token,
            token_type: self.token_type,
            expires_in: self.expires_in,
        })
    }
}
