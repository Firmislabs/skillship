use crate::api::*;
use crate::{ApiError, ClientConfig, HttpClient, QueryBuilder, RequestOptions};
use reqwest::Method;
use std::collections::HashMap;

pub struct ItemsClient {
    pub http_client: HttpClient,
}

impl ItemsClient {
    pub fn new(config: ClientConfig) -> Result<Self, ApiError> {
        Ok(Self {
            http_client: HttpClient::new(config.clone())?,
        })
    }

    /// Returns a cursor-paginated page of items.
    ///
    /// # Arguments
    ///
    /// * `options` - Additional request options such as headers, timeout, etc.
    ///
    /// # Returns
    ///
    /// JSON response from the API
    pub async fn list(
        &self,
        request: &ItemsListQueryRequest,
        options: Option<RequestOptions>,
    ) -> Result<ItemsListResponse, ApiError> {
        self.http_client
            .execute_request(
                Method::GET,
                "items",
                None,
                QueryBuilder::new()
                    .string("cursor", request.cursor.clone())
                    .int("limit", request.limit.clone())
                    .build(),
                options,
            )
            .await
    }

    pub async fn create(
        &self,
        request: &HashMap<String, serde_json::Value>,
        options: Option<RequestOptions>,
    ) -> Result<ItemsCreateResponse, ApiError> {
        self.http_client
            .execute_request(
                Method::POST,
                "items",
                Some(serde_json::to_value(request).map_err(ApiError::Serialization)?),
                None,
                options,
            )
            .await
    }
}
