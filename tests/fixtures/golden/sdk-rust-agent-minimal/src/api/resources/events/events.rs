use crate::api::*;
use crate::{ApiError, ClientConfig, HttpClient, QueryBuilder, RequestOptions};
use reqwest::Method;

pub struct EventsClient {
    pub http_client: HttpClient,
}

impl EventsClient {
    pub fn new(config: ClientConfig) -> Result<Self, ApiError> {
        Ok(Self {
            http_client: HttpClient::new(config.clone())?,
        })
    }

    /// Returns events for the account. Paginated using cursor and per_page. Supports filtering by type.
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
        request: &EventsListQueryRequest,
        options: Option<RequestOptions>,
    ) -> Result<EventsListResponse, ApiError> {
        self.http_client
            .execute_request(
                Method::GET,
                "events",
                None,
                QueryBuilder::new()
                    .string("cursor", request.cursor.clone())
                    .int("per_page", request.per_page.clone())
                    .build(),
                options,
            )
            .await
    }
}
