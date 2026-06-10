use crate::api::*;
use crate::{ApiError, ClientConfig, HttpClient, RequestOptions};
use reqwest::Method;

pub struct OauthClient {
    pub http_client: HttpClient,
}

impl OauthClient {
    pub fn new(config: ClientConfig) -> Result<Self, ApiError> {
        Ok(Self {
            http_client: HttpClient::new(config.clone())?,
        })
    }

    /// Client-credentials token endpoint. Intentionally authless.
    ///
    /// # Arguments
    ///
    /// * `options` - Additional request options such as headers, timeout, etc.
    ///
    /// # Returns
    ///
    /// JSON response from the API
    pub async fn token(
        &self,
        options: Option<RequestOptions>,
    ) -> Result<OauthTokenResponse, ApiError> {
        self.http_client
            .execute_request(Method::POST, "oauth/token", None, None, options)
            .await
    }
}
