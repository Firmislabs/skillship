//! Service clients and API endpoints
//!
//! This module contains client implementations for:
//!
//! - **Events**
//! - **Items**
//! - **Logs**
//! - **Oauth**

use crate::{ApiError, ClientConfig};

pub mod events;
pub mod items;
pub mod logs;
pub mod oauth;
pub struct ApiClient {
    pub config: ClientConfig,
    pub events: EventsClient,
    pub items: ItemsClient,
    pub logs: LogsClient,
    pub oauth: OauthClient,
}

impl ApiClient {
    pub fn new(config: ClientConfig) -> Result<Self, ApiError> {
        Ok(Self {
            config: config.clone(),
            events: EventsClient::new(config.clone())?,
            items: ItemsClient::new(config.clone())?,
            logs: LogsClient::new(config.clone())?,
            oauth: OauthClient::new(config.clone())?,
        })
    }
}

pub use events::EventsClient;
pub use items::ItemsClient;
pub use logs::LogsClient;
pub use oauth::OauthClient;
