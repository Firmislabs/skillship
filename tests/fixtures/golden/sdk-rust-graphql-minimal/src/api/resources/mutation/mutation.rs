use crate::api::*;
use crate::{ApiError, ClientConfig, HttpClient, QueryBuilder, RequestOptions};
use reqwest::Method;

pub struct MutationClient {
    pub http_client: HttpClient,
}

impl MutationClient {
    pub fn new(config: ClientConfig) -> Result<Self, ApiError> {
        Ok(Self {
            http_client: HttpClient::new(config.clone())?,
        })
    }

    pub async fn create_project(
        &self,
        request: &CreateProjectQueryRequest,
        options: Option<RequestOptions>,
    ) -> Result<(), ApiError> {
        self.http_client
            .execute_request(
                Method::POST,
                "graphql#createProject",
                None,
                QueryBuilder::new()
                    .string("input", request.input.clone())
                    .build(),
                options,
            )
            .await
    }
}
