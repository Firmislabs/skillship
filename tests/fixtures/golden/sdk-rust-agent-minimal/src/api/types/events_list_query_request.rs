pub use crate::prelude::*;

/// Query parameters for list
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct EventsListQueryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_page: Option<i64>,
}

impl EventsListQueryRequest {
    pub fn builder() -> EventsListQueryRequestBuilder {
        <EventsListQueryRequestBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct EventsListQueryRequestBuilder {
    cursor: Option<String>,
    per_page: Option<i64>,
}

impl EventsListQueryRequestBuilder {
    pub fn cursor(mut self, value: impl Into<String>) -> Self {
        self.cursor = Some(value.into());
        self
    }

    pub fn per_page(mut self, value: i64) -> Self {
        self.per_page = Some(value);
        self
    }

    /// Consumes the builder and constructs a [`EventsListQueryRequest`].
    pub fn build(self) -> Result<EventsListQueryRequest, BuildError> {
        Ok(EventsListQueryRequest {
            cursor: self.cursor,
            per_page: self.per_page,
        })
    }
}
