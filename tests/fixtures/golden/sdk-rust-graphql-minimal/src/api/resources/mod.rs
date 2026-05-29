//! Service clients and API endpoints
//!
//! This module contains client implementations for:
//!
//! - **Mutation**
//! - **Query**

use crate::{ApiError, ClientConfig};

pub mod mutation;
pub mod query;
pub struct ApiClient {
    pub config: ClientConfig,
    pub mutation: MutationClient,
    pub query: QueryClient,
}

impl ApiClient {
    pub fn new(config: ClientConfig) -> Result<Self, ApiError> {
        Ok(Self {
            config: config.clone(),
            mutation: MutationClient::new(config.clone())?,
            query: QueryClient::new(config.clone())?,
        })
    }
}

pub use mutation::MutationClient;
pub use query::QueryClient;
