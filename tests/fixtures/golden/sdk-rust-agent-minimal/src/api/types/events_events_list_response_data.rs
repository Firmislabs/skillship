pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct EventsListResponseData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<EventsListResponseDataResultsItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl EventsListResponseData {
    pub fn builder() -> EventsListResponseDataBuilder {
        <EventsListResponseDataBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct EventsListResponseDataBuilder {
    results: Option<Vec<EventsListResponseDataResultsItem>>,
    next_cursor: Option<String>,
}

impl EventsListResponseDataBuilder {
    pub fn results(mut self, value: Vec<EventsListResponseDataResultsItem>) -> Self {
        self.results = Some(value);
        self
    }

    pub fn next_cursor(mut self, value: impl Into<String>) -> Self {
        self.next_cursor = Some(value.into());
        self
    }

    /// Consumes the builder and constructs a [`EventsListResponseData`].
    pub fn build(self) -> Result<EventsListResponseData, BuildError> {
        Ok(EventsListResponseData {
            results: self.results,
            next_cursor: self.next_cursor,
        })
    }
}
