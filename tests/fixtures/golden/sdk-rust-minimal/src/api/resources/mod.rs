//! Service clients and API endpoints
//!
//! This module contains client implementations for:
//!
//! - **Projects**

use crate::{ApiError, ClientConfig};

pub mod projects;
pub struct ApiClient {
    pub config: ClientConfig,
    pub projects: ProjectsClient,
}

impl ApiClient {
    pub fn new(config: ClientConfig) -> Result<Self, ApiError> {
        Ok(Self {
            config: config.clone(),
            projects: ProjectsClient::new(config.clone())?,
        })
    }
}

pub use projects::ProjectsClient;
